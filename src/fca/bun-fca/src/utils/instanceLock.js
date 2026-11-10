"use strict";

const fs = require("fs");
const path = require("path");
const STALE_MS = 120000;
let timer = null;

function acquire(userID) {
  if (/^(off|0|false)$/i.test(String(process.env.FCA_NX_INSTANCE_LOCK || ""))) return { ok: true };
  const dir = process.env.BUN_FCA_STATE_DIR || path.join(process.cwd(), ".bun-fca");
  const file = path.join(dir, "instance_" + String(userID || "default") + ".lock");
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const cur = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cur && cur.pid !== process.pid && Date.now() - cur.at < STALE_MS) {
        let alive = true;
        try { process.kill(cur.pid, 0); } catch (e) { alive = e.code === "EPERM"; }

        if (alive || Date.now() - cur.at < 45000) return { ok: false, pid: cur.pid };
      }
    } catch (_) {}
    const beat = () => { try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch (_) {} };
    beat();
    if (timer) clearInterval(timer);
    timer = setInterval(beat, 30000);
    if (timer.unref) timer.unref();
    const release = () => { try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (c.pid === process.pid) fs.unlinkSync(file); } catch (_) {} };
    process.once("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { release(); process.exit(0); });
  } catch (_) {   }
  return { ok: true };
}

module.exports = { acquire };