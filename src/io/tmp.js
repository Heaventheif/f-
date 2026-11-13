// One temp root per process; every job gets its own private directory
// that is ALWAYS removed. Replaces prefix-based sweeping and Date.now() names.
import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT_PREFIX = "sunkenbot-";
let rootPromise;
export function tmpRoot() {
  return (rootPromise ??= mkdtemp(join(tmpdir(), ROOT_PREFIX)));
}
export async function withTempDir(fn, label = "job") {
  const dir = await mkdtemp(join(await tmpRoot(), `${label.replace(/\W/g, "")}-`));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
// Safe file name inside dir: random, extension whitelisted.
export function tmpName(dir, ext = "bin") {
  const e = String(ext).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  return join(dir, `${randomUUID()}.${e}`);
}
export async function writeTmp(dir, buf, ext) {
  const p = tmpName(dir, ext);
  await writeFile(p, buf, { flag: "wx", mode: 0o600 });
  return p;
}
// Startup sweep: remove stale roots of previous (dead) processes.
export async function sweepStaleRoots(maxAgeMs = 3600_000) {
  const base = tmpdir();
  const mine = basename(await tmpRoot());
  let n = 0;
  for (const name of await readdir(base).catch(() => [])) {
    if (!name.startsWith(ROOT_PREFIX) || name === mine) continue;
    const p = join(base, name);
    const s = await stat(p).catch(() => null);
    if (s && Date.now() - s.mtimeMs > maxAgeMs) { await rm(p, { recursive: true, force: true }).catch(() => {}); n++; }
  }
  return n;
}
