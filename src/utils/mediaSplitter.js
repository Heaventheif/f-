"use strict";
import fs from "./fsCompat.js";
import path from "path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "child_process";
import { tmpRoot } from "../io/tmp.js";
import { AppError } from "../infra/errors.js";
import { safeExt } from "./mediaFile.js";

const MAX_PART_BYTES = 24 * 1024 * 1024;
const TARGET_RATIO = 0.85;
const MAX_ATTEMPTS = 4; // attempt 0 = stream copy, the rest re-encode with shrinking segments
const AUDIO_ENCODERS = { mp3: "libmp3lame", ogg: "libvorbis", opus: "libopus" };
const AUDIO_EXTS = new Set(["mp3", "m4a", "ogg", "opus", "wav", "aac", "amr"]);

function NEEDS_SPLIT(sizeBytes, max = MAX_PART_BYTES) {
  return sizeBytes > max;
}

// Pure: segment length (seconds) so an average part lands at ~85% of the cap; `shrink` tightens it on retries.
export function planSegmentSeconds(size, durationSec, maxPart = MAX_PART_BYTES, shrink = 1) {
  const bytesPerSecond = size / durationSec;
  return Math.max(1, Math.floor((maxPart * TARGET_RATIO * shrink) / bytesPerSecond));
}
export const findOversize = (entries, max = MAX_PART_BYTES) => entries.filter((e) => e.size > max);

// Pure: ffmpeg args. Maps only video+audio (data/subtitle streams break segmenting).
export function buildSegmentArgs(input, pattern, ext, seconds, { reencode = false } = {}) {
  const args = ["-y", "-i", input, "-map", "0:v?", "-map", "0:a?"];
  if (!reencode) args.push("-c", "copy");
  else if (AUDIO_EXTS.has(ext)) args.push("-vn", "-c:a", AUDIO_ENCODERS[ext] || "aac", "-b:a", "96k");
  else
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k",
      "-force_key_frames", `expr:gte(t,n_forced*${seconds})`);
  args.push("-f", "segment", "-segment_time", String(seconds), "-reset_timestamps", "1", pattern);
  return args;
}

function run(cmd, args, timeout, maxBuffer = 1024 * 1024 * 10) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer }, (err, stdout, stderr) =>
      err ? reject(new AppError("upstream", `${cmd} failed: ${String(stderr || err.message).slice(-300)}`, { cause: err })) : resolve(String(stdout))));
}
async function probeDuration(filePath) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], 30_000);
  const duration = parseFloat(out.trim());
  if (!duration || !isFinite(duration) || duration <= 0) throw new AppError("upstream", "ffprobe_no_duration");
  return duration;
}
async function listParts(workDir) {
  const names = (await fs.readdir(workDir)).filter((f) => f.startsWith("part_")).sort();
  return Promise.all(names.map(async (n) => { const p = path.join(workDir, n); return { path: p, size: (await fs.stat(p)).size }; }));
}
async function makeWorkDir(dir) {
  if (dir) { const d = path.join(dir, `split-${randomUUID()}`); await mkdir(d, { recursive: true }); return d; }
  return mkdtemp(path.join(await tmpRoot(), "split-"));
}

/**
 * Split into parts <= maxPart. Pass `dir` (from withTempDir) so cleanup is automatic;
 * otherwise a private dir is created and cleanupParts() must be called.
 * Throws AppError("too_large") when no attempt gets every part under the cap.
 */
async function splitFile(filePath, extension = "mp4", { dir, maxPart = MAX_PART_BYTES } = {}) {
  const ext = safeExt(extension, "mp4");
  const size = (await fs.stat(filePath)).size;
  const duration = await probeDuration(filePath);
  const workDir = await makeWorkDir(dir);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      for (const f of await fs.readdir(workDir)) await fs.remove(path.join(workDir, f));
      const reencode = attempt > 0;
      const seconds = planSegmentSeconds(size, duration, maxPart, reencode ? 0.6 ** (attempt - 1) : 1);
      await run("ffmpeg", buildSegmentArgs(filePath, path.join(workDir, `part_%03d.${ext}`), ext, seconds, { reencode }), 10 * 60_000);
      const parts = await listParts(workDir);
      if (parts.length && !parts.some((p) => p.size === 0) && findOversize(parts, maxPart).length === 0) return parts.map((p) => p.path);
      // a segment can only be shorter than one keyframe interval; if copy cannot shrink it, re-encode next round
    }
    throw new AppError("too_large", "split_still_oversize");
  } catch (e) {
    await fs.remove(workDir).catch(() => {});
    if (e instanceof AppError) throw e;
    throw new AppError("too_large", `split_failed: ${e.message}`, { cause: e });
  }
}
async function cleanupParts(partPaths) {
  const dirs = new Set((partPaths || []).map((p) => path.dirname(p)));
  await Promise.allSettled([...dirs].map((d) => fs.remove(d)));
}
export { splitFile, cleanupParts, NEEDS_SPLIT, MAX_PART_BYTES };
