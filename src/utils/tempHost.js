"use strict";

// Self-hosted temporary file hosting.
// Files are written to a private folder and served by the bot's own web server
// at  <PUBLIC_BASE_URL>/f/<id>.<ext>  until the TTL expires.
// Expiry is derived from the file's mtime, so it survives process restarts and
// needs no in-memory registry.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOST_DIR = path.join(process.env.TMPDIR || os.tmpdir(), "sunkenbot-hosted");
const DEFAULT_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.HOSTED_TTL_HOURS || "24", 10) * 3600_000
);
const NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]{2,5}$/;

const MIME = {
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg",
  opus: "audio/opus", wav: "audio/wav", webm: "audio/webm", amr: "audio/amr",
  jpg: "image/jpeg", png: "image/png",
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
  const h = Math.round(ttlMs / 3600_000);
  if (h >= 48 && h % 24 === 0) return `${h / 24} يوم`;
  if (h === 24) return "24 ساعة";
  if (h >= 1) return `${h} ساعة`;
  return `${Math.round(ttlMs / 60_000)} دقيقة`;
}

export async function hostBuffer(buffer, ext) {
  const base = publicBaseUrl();
  if (!isSelfHostAvailable()) {
    throw new Error("لم يُضبط RENDER_EXTERNAL_URL/PUBLIC_URL (https)");
  }
  const safeExt = String(ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  await mkdir(HOST_DIR, { recursive: true });
  const name = `${randomBytes(16).toString("hex")}.${safeExt}`;
  await writeFile(path.join(HOST_DIR, name), buffer);
  return { url: `${base}/f/${name}`, ttlMs: DEFAULT_TTL_MS };
}

// Called from the web server for GET /f/<name>
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

  const file = Bun.file(fp);
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
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...headers, "Content-Length": String(st.size) } });
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
  } catch (_) {} // folder may not exist yet
}

setInterval(cleanupHosted, 30 * 60 * 1000).unref();
