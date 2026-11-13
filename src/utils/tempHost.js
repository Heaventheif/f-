"use strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError } from "../infra/errors.js";
import os from "node:os";
import path from "node:path";
const HOST_DIR = path.join(process.env.TMPDIR || os.tmpdir(), "sunkenbot-hosted");
const DEFAULT_TTL_MS = Math.max(6e4, parseInt(process.env.HOSTED_TTL_HOURS || "24", 10) * 36e5);
export const MAX_HOSTED_BYTES = Math.max(1, parseInt(process.env.HOSTED_MAX_MB || "50", 10)) * 1024 * 1024;
const NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;
const MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  webm: "audio/webm",
  amr: "audio/amr",
  jpg: "image/jpeg",
  png: "image/png",
};
export function publicBaseUrl() {
  return String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
}
export function isSelfHostAvailable() {
  return /^https:\/\//i.test(publicBaseUrl());
}
export function ttlLabel(ttlMs = DEFAULT_TTL_MS) {
  const h = Math.round(ttlMs / 36e5);
  if (h >= 48 && h % 24 === 0) return `${h / 24} يوم`;
  if (h === 24) return "24 ساعة";
  if (h >= 1) return `${h} ساعة`;
  return `${Math.round(ttlMs / 6e4)} دقيقة`;
}
export async function hostBuffer(buffer, ext) {
  const base = publicBaseUrl();
  if (!isSelfHostAvailable()) {
    throw new AppError("upstream", "لم يُضبط RENDER_EXTERNAL_URL/PUBLIC_URL (https)");
  }
  if (!buffer?.length) throw new AppError("upstream", "empty_buffer");
  if (buffer.length > MAX_HOSTED_BYTES) throw new AppError("too_large", "hosted_size_cap");
  const safeExt =
    String(ext || "bin")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 5) || "bin";
  await mkdir(HOST_DIR, { recursive: true });
  const name = `${randomBytes(16).toString("hex")}.${safeExt}`;
  await writeFile(path.join(HOST_DIR, name), buffer, { flag: "wx", mode: 0o600 });
  return { url: `${base}/f/${name}`, ttlMs: DEFAULT_TTL_MS };
}
export async function serveHostedFile(name, req) {
  if (!NAME_RE.test(name)) return new Response("Not Found", { status: 404 });
  const fp = path.join(HOST_DIR, name);
  let st;
  try {
    st = await stat(fp);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (Date.now() - st.mtimeMs > DEFAULT_TTL_MS) {
    rm(fp, { force: true }).catch(() => {});
    return new Response("Expired", { status: 410 });
  }
  const ext = name.split(".").pop();
  const type = MIME[ext] || "application/octet-stream";
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${name}"`,
  };
  // Bun.file when running on Bun, plain node streams otherwise (never crash on other runtimes).
  const body = (start, end) =>
    typeof Bun !== "undefined"
      ? (start === undefined ? Bun.file(fp) : Bun.file(fp).slice(start, end + 1))
      : Readable.toWeb(createReadStream(fp, start === undefined ? {} : { start, end }));
  const range = req?.headers?.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const size = st.size;
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(body(start, end), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(body(), { headers: { ...headers, "Content-Length": String(st.size) } });
}
export async function cleanupHosted() {
  try {
    const now = Date.now();
    for (const name of await readdir(HOST_DIR)) {
      const fp = path.join(HOST_DIR, name);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > DEFAULT_TTL_MS) await rm(fp, { force: true });
      } catch (_) {}
    }
  } catch (_) {}
}
setInterval(cleanupHosted, 30 * 60 * 1e3).unref();
