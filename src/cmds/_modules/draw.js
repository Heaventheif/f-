import fs from "../../utils/fsCompat.js";
import { randomInt } from "node:crypto";
import { fetchBuffer, fetchJson, sniffImage } from "../../net/safeFetch.js";
import { AppError, userMessage } from "../../infra/errors.js";
import { Semaphore, pool } from "../../infra/limiter.js";
import { withTempDir, writeTmp } from "../../io/tmp.js";
import { translateToEnglish } from "../../utils/translator.js";
import { sendStatus, sendPayload, reply, unsendQuiet } from "../../media/common.js";

const MODELS = {
  flux: "flux",
  "flux-realism": "flux-realism",
  turbo: "turbo",
  gptimage: "gptimage",
  fast: "turbo",
  real: "flux-realism",
  artx: "artx",
  editz: "artx",
};
const RATIOS = {
  "1:1": { w: 1024, h: 1024 },
  "16:9": { w: 1344, h: 768 },
  "9:16": { w: 768, h: 1344 },
  "4:3": { w: 1152, h: 864 },
  "3:4": { w: 864, h: 1152 },
  "21:9": { w: 1536, h: 640 },
  "3:2": { w: 1216, h: 832 },
  "2:3": { w: 832, h: 1216 },
};
const STYLES = {
  anime: "anime illustration, vibrant colors, detailed linework, Studio Ghibli",
  realistic: "photorealistic, cinematic 4k, sharp focus, natural lighting",
  cyberpunk: "cyberpunk, neon lights, rain-soaked streets, futuristic dystopia",
  fantasy: "epic fantasy art, magical atmosphere, dramatic lighting",
  portrait: "professional portrait photography, studio lighting, shallow depth of field",
  sketch: "pencil sketch, fine line art, hand-drawn, crosshatching, monochrome",
  watercolor: "watercolor painting, soft edges, pastel tones, fluid brushstrokes",
  oil: "oil painting, textured brushstrokes, museum quality, renaissance style",
  pixel: "pixel art, retro 16-bit game style, limited color palette",
  dark: "dark moody atmosphere, dramatic shadows, cinematic noir",
};
const MAX_PROMPT_CHARS = 400;
const IMAGE_COUNT = 4;
const TOTAL_TIMEOUT_MS = 3 * 60 * 1e3;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const gate = new Semaphore(2); // global: at most two /draw jobs at once
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0",
  Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
  "Cache-Control": "no-cache",
};
const ARTX_BASE = "https://toshiro-api-editz6t9.vercel.app";

const randomSeed = () => randomInt(1, 2 ** 31 - 1);
// Distinct seeds: explicit seed N -> N, N+1, ...; otherwise random per image.
export function makeSeeds(count, seed = null) {
  if (Number.isInteger(seed)) return Array.from({ length: count }, (_, i) => seed + i);
  const set = new Set();
  while (set.size < count) set.add(randomSeed());
  return [...set];
}

export function parseArgs(args) {
  const rest = [...args];
  let model = "flux", ratio = "1:1", styleTag = null, seed = null;
  for (;;) {
    const w = rest[0];
    if (!w) break;
    const lw = w.toLowerCase();
    const seedMatch = lw.match(/^(?:seed[=:]|--seed=)(\d{1,10})$/);
    if (MODELS[lw]) model = MODELS[rest.shift().toLowerCase()];
    else if (RATIOS[w]) ratio = rest.shift();
    else if (STYLES[lw]) styleTag = rest.shift().toLowerCase();
    else if (seedMatch) { seed = Number(seedMatch[1]); rest.shift(); }
    else break;
  }
  return { model, ratio, styleTag, seed, rawPrompt: rest.join(" ").trim().slice(0, MAX_PROMPT_CHARS) };
}

const buildUrl = (prompt, model, dims, seed) =>
  `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=${model}&width=${dims.w}&height=${dims.h}&seed=${seed}&nologo=true&enhance=true&nofeed=true`;

// Validate real image bytes (never trust content-type) and store inside `dir`.
async function saveImage(dir, buf) {
  const kind = sniffImage(buf);
  if (!kind) throw new AppError("upstream", "non_image_response");
  return writeTmp(dir, buf, kind);
}
async function downloadImage(dir, prompt, model, dims, seed, signal) {
  if (signal?.aborted) throw signal.reason ?? new AppError("timeout", "cancelled");
  const buf = await fetchBuffer(buildUrl(prompt, model, dims, seed), {
    signal, timeoutMs: 60_000, retries: 2, maxBytes: MAX_IMAGE_BYTES, allowHosts: ["pollinations.ai"], headers: FETCH_HEADERS,
  });
  return saveImage(dir, buf);
}

// Run every seed through `fetchOne` with bounded parallelism; one failure never discards the others.
export async function collectDraw(seeds, fetchOne, { limit = 2, onProgress } = {}) {
  let done = 0;
  const settled = await pool(seeds, limit, async (seed, i) => {
    try { return await fetchOne(seed, i); }
    finally { onProgress?.(++done, seeds.length); }
  });
  return {
    files: settled.filter((r) => r.ok).map((r) => r.value),
    failures: settled.filter((r) => !r.ok).map((r) => r.error),
  };
}

export function decodeDataUri(uri) {
  const match = /^data:image\/(\w+);base64,(.+)$/s.exec(String(uri).trim());
  if (!match) throw new AppError("upstream", "bad_data_uri");
  return Buffer.from(match[2], "base64");
}
async function downloadArtx(dir, prompt, signal) {
  const json = await fetchJson(`${ARTX_BASE}/api/image/Artx?prompt=${encodeURIComponent(prompt)}`, {
    signal, timeoutMs: 45e3, retries: 1, maxBytes: 40 * 1024 * 1024, allowHosts: ["vercel.app"],
    headers: { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "application/json" },
  });
  if (!json || json.success !== true) throw new AppError("upstream", json?.error || json?.message || "artx_failed");
  const images = json.result?.images;
  if (!Array.isArray(images) || !images.length) throw new AppError("not_found", "artx_no_images");
  const files = [];
  for (const uri of images.slice(0, IMAGE_COUNT)) {
    try {
      const buf = decodeDataUri(uri);
      if (buf.length >= 100 && buf.length <= MAX_IMAGE_BYTES) files.push(await saveImage(dir, buf));
    } catch { /* skip corrupt image */ }
  }
  if (!files.length) throw new AppError("upstream", "artx_all_corrupt");
  return files;
}

const drawError = (err, engine) =>
  err?.status === 429 ? `❌ خادم ${engine} مشغول (429) — انتظر دقيقة وحاول مجدداً.` : `❌ فشل التوليد: ${userMessage(err)}\nحاول مجدداً.`;

function captionOf({ title, rawPrompt, englishPrompt, styleTag, extra }) {
  return [
    title,
    `📝 ${rawPrompt.substring(0, 80)}`,
    englishPrompt.trim().toLowerCase() !== rawPrompt.trim().toLowerCase() ? `🌐 ${englishPrompt.substring(0, 80)}` : null,
    styleTag ? `🎭 ${styleTag}` : null,
    extra || null,
  ].filter(Boolean).join("\n");
}

async function runJob({ api, threadID, messageID, model, ratio, styleTag, seed, rawPrompt, englishPrompt }) {
  const artx = model === "artx";
  const statusMsg = await sendStatus(
    api, threadID,
    artx ? `🎨 جاري التوليد (ArtX)...\n📝 ${rawPrompt.substring(0, 60)}`
      : `🎨 جاري التوليد (${model} · ${ratio})...\n📝 ${rawPrompt.substring(0, 60)}\n⏳ صورة 1/${IMAGE_COUNT} — يستغرق 30–60 ثانية`,
    messageID,
  );
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new AppError("timeout", "draw_deadline")), TOTAL_TIMEOUT_MS);
  try {
    await withTempDir(async (dir) => {
      let files, failures = [], seeds = [];
      if (artx) files = await downloadArtx(dir, englishPrompt, ctl.signal);
      else {
        const dims = RATIOS[ratio];
        seeds = makeSeeds(IMAGE_COUNT, seed);
        ({ files, failures } = await collectDraw(seeds, (s) => downloadImage(dir, englishPrompt, model, dims, s, ctl.signal), {
          onProgress: (n) => {
            if (statusMsg?.messageID && n < IMAGE_COUNT)
              Promise.resolve(api.editMessage(`🎨 جاري التوليد (${model} · ${ratio})...\n📝 ${rawPrompt.substring(0, 60)}\n⏳ ${n}/${IMAGE_COUNT} جاهزة...`, statusMsg.messageID)).catch(() => {});
          },
        }));
        if (!files.length) throw failures[0] ?? new AppError("upstream", "no_images");
      }
      const title = artx ? `🖼️ ArtX (Toshiro Editz) · ${files.length} صورة` : `🖼️ FLUX (${model}) · ${ratio}`;
      const extra = [
        !artx && files.length < IMAGE_COUNT ? `⚠️ ${files.length}/${IMAGE_COUNT} صور فقط نجحت` : null,
        !artx && Number.isInteger(seed) ? `🎲 seed ${seed}` : null,
      ].filter(Boolean).join(" · ");
      await unsendQuiet(api, statusMsg?.messageID);
      await sendPayload(api, threadID, { body: captionOf({ title, rawPrompt, englishPrompt, styleTag, extra }), attachment: files.map((f) => fs.createReadStream(f)) }, messageID);
    }, "draw");
  } catch (err) {
    console.error("[DRAW]", err?.code || "", String(err?.message).slice(0, 200));
    await unsendQuiet(api, statusMsg?.messageID);
    await reply(api, threadID, drawError(ctl.signal.aborted ? ctl.signal.reason : err, artx ? "ArtX" : "الصور"), messageID);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  config: {
    name: "draw",
    aliases: ["flux"],
    version: "3.0.0",
    role: 0,
    countDown: 20,
    category: "ذكاء اصطناعي",
    description: "توليد 4 صور بالذكاء الاصطناعي — FLUX (Pollinations.ai) أو ArtX (Toshiro Editz)",
    usage: [
      "{pn}draw <وصف>",
      "{pn}draw flux-realism <وصف>",
      "{pn}draw turbo <وصف>",
      "{pn}draw artx <وصف>",
      "{pn}draw 16:9 <وصف>",
      "{pn}draw anime <وصف>",
      "{pn}draw seed=123 <وصف>",
      "{pn}draw help",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID } = event;
    if (!args[0] || args[0].toLowerCase() === "help") {
      return message.reply(
        "🖼️ توليد الصور بالذكاء الاصطناعي\n━━━━━━━━━━━━━━━━━\n\n🤖 النماذج:\n  flux          — الافتراضي (Pollinations)\n  flux-realism  — أكثر واقعية\n  turbo         — الأسرع\n  gptimage      — نمط GPT-4o\n  artx          — محرك ArtX (Toshiro Editz) — أسرع، طلب واحد فقط\n\n📐 النسب (لا تنطبق على artx):\n  " +
          Object.keys(RATIOS).join(" · ") +
          "\n\n🎭 الأنماط:\n  " +
          Object.keys(STYLES).join(" · ") +
          "\n\n📝 أمثلة:\n  draw dragon over neon city\n  draw flux-realism 16:9 mountain at sunrise\n  draw anime فتاة تحت المطر في طوكيو\n  draw artx cyberpunk cat\n\n🆓 مجاني — لا تسجيل ولا API key",
      );
    }
    const { model, ratio, styleTag, seed, rawPrompt } = parseArgs(args);
    if (!rawPrompt) return message.reply("❓ اكتب وصف الصورة بعد الأمر.");
    let englishPrompt = await translateToEnglish(rawPrompt).catch(() => rawPrompt);
    englishPrompt = String(englishPrompt || rawPrompt).slice(0, MAX_PROMPT_CHARS);
    if (styleTag) englishPrompt = `${englishPrompt}, ${STYLES[styleTag]}`;
    await gate.run(() => runJob({ api, threadID, messageID, model, ratio, styleTag, seed, rawPrompt, englishPrompt }));
  },
};
