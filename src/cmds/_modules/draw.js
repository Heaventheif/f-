 import fs   from "fs-extra";
import path from "path";
import os   from "os";
import { translateToEnglish } from "../../utils/translator.js";
const MODELS = {
  flux:           "flux",
  "flux-realism": "flux-realism",
  turbo:          "turbo",
  gptimage:       "gptimage",
  fast:           "turbo",
  real:           "flux-realism",
  artx:           "artx",
  editz:          "artx",
};
const RATIOS = {
  "1:1":  { w: 1024, h: 1024 },
  "16:9": { w: 1344, h: 768  },
  "9:16": { w: 768,  h: 1344 },
  "4:3":  { w: 1152, h: 864  },
  "3:4":  { w: 864,  h: 1152 },
  "21:9": { w: 1536, h: 640  },
  "3:2":  { w: 1216, h: 832  },
  "2:3":  { w: 832,  h: 1216 },
};
const STYLES = {
  anime:      "anime illustration, vibrant colors, detailed linework, Studio Ghibli",
  realistic:  "photorealistic, cinematic 4k, sharp focus, natural lighting",
  cyberpunk:  "cyberpunk, neon lights, rain-soaked streets, futuristic dystopia",
  fantasy:    "epic fantasy art, magical atmosphere, dramatic lighting",
  portrait:   "professional portrait photography, studio lighting, shallow depth of field",
  sketch:     "pencil sketch, fine line art, hand-drawn, crosshatching, monochrome",
  watercolor: "watercolor painting, soft edges, pastel tones, fluid brushstrokes",
  oil:        "oil painting, textured brushstrokes, museum quality, renaissance style",
  pixel:      "pixel art, retro 16-bit game style, limited color palette",
  dark:       "dark moody atmosphere, dramatic shadows, cinematic noir",
};
const SEEDS          = [42, 137, 512, 999];
const FALLBACK_SEEDS = [1337, 2048, 7777, 31415];
const DELAY          = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_HEADERS = {
  "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0",
  "Accept":        "image/webp,image/apng,image/*,*/*;q=0.8",
  "Cache-Control": "no-cache",
};

// ─── محرك ArtX (Toshiro Editz) ────────────────────────────────────
// نقطة نهاية واحدة تُرجع مباشرة 4 صور بصيغة base64 ضمن JSON — لا حاجة
// لتحميل متعدد أو seeds أو retry لكل صورة على حدة، فقط طلب واحد.
const ARTX_BASE    = "https://toshiro-api-editz6t9.vercel.app";
const ARTX_TIMEOUT = 45_000;

function buildArtxUrl(prompt) {
  return `${ARTX_BASE}/api/image/Artx?prompt=${encodeURIComponent(prompt)}`;
}

// يفكّ ترميز data URI (data:image/png;base64,XXXX) إلى Buffer، ويتحقق
// من الصيغة قبل المحاولة حتى لا نكتب ملف تالف بصمت.
function decodeDataUri(uri) {
  const match = /^data:image\/(\w+);base64,(.+)$/s.exec(String(uri).trim());
  if (!match) throw new Error("صيغة صورة غير متوقعة من ArtX");
  const [, ext, b64] = match;
  return { ext: ext.toLowerCase(), buffer: Buffer.from(b64, "base64") };
}

async function downloadArtx(prompt, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTX_TIMEOUT);
    try {
      const res = await fetch(buildArtxUrl(prompt), {
        signal:  controller.signal,
        headers: { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "application/json" },
      }).finally(() => clearTimeout(timer));

      if (res.status === 429 || res.status === 502 || res.status === 503) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        e.retriable = true;
        throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json().catch(() => null);
      if (!json || json.success !== true) {
        throw new Error(json?.error || json?.message || "استجابة غير ناجحة من ArtX");
      }
      const images = json.result?.images;
      if (!Array.isArray(images) || images.length === 0) {
        throw new Error("لم ترجع ArtX أي صور");
      }

      const files = [];
      for (let i = 0; i < images.length; i++) {
        const { ext, buffer } = decodeDataUri(images[i]);
        if (buffer.length < 100) continue; // صورة فاسدة/فارغة — تجاهلها
        const f = path.join(os.tmpdir(), `artx_${Date.now()}_${i}.${ext || "png"}`);
        await fs.writeFile(f, buffer);
        files.push(f);
      }
      if (files.length === 0) throw new Error("كل الصور المُستلمة كانت فاسدة");
      return files;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isTimeout   = err.name === "AbortError";
      const isRetriable = err.retriable || isTimeout;
      if (!isRetriable || attempt === maxRetries - 1) throw err;
      const wait = 3_000 * Math.pow(2, attempt);
      console.warn(`[DRAW:artx] ${err.status ?? "timeout"} attempt=${attempt + 1} — waiting ${wait / 1000}s`);
      await DELAY(wait);
    }
  }
  throw lastErr;
}

function buildUrl(prompt, model, dims, seed) {
  return (
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${model}&width=${dims.w}&height=${dims.h}&seed=${seed}` +
    `&nologo=true&enhance=true&nofeed=true`
  );
}
async function downloadImage(prompt, model, dims, seed, idx, maxRetries = 3) { // C-04 fix: reduced from 4 to 3
  let url = buildUrl(prompt, model, dims, seed);
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000); // C-04 fix: reduced from 120s to 60s
    try {
      const res = await fetch(url, {
        signal:   controller.signal,
        headers:  FETCH_HEADERS,
        redirect: "follow",
      }).finally(() => clearTimeout(timer));
      if (res.status === 429 || res.status === 502 || res.status === 503) {
        const e    = new Error(`HTTP ${res.status}`);
        e.status   = res.status;
        e.retriable = true;
        throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct  = res.headers.get("content-type") ?? "";
      const buf = await res.arrayBuffer();
      if (!ct.includes("image") && buf.byteLength < 5_000) {
        throw new Error(`non-image response (${ct})`);
      }
      const f = path.join(os.tmpdir(), `draw_${Date.now()}_${idx}.jpg`);
      await fs.writeFile(f, Buffer.from(buf));
      return f;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isTimeout   = err.name === "AbortError";
      const isRetriable = err.retriable || isTimeout;
      if (!isRetriable) throw err;
      const wait = 4_000 * Math.pow(2, attempt);
      console.warn(
        `[DRAW] ${err.status ?? "timeout"} seed=${seed} attempt=${attempt + 1} — waiting ${wait / 1000}s`
      );
      await DELAY(wait);
      if (attempt === 1) {
        seed = FALLBACK_SEEDS[idx] ?? seed + 1111;
        url  = buildUrl(prompt, model, dims, seed);
        console.warn(`[DRAW] switching to fallback seed=${seed}`);
      }
    }
  }
  throw lastErr;
}
async function downloadAllSequential(prompt, model, dims, onProgress) {
  // C-04 fix: hard cap of 3 minutes — use Promise.race so the timeout is
  // catchable inside the normal async/await call stack (setTimeout + throw
  // fires in a separate call stack and cannot be caught by try/catch).
  const TOTAL_TIMEOUT_MS = 3 * 60 * 1000;
  const files = [];
  let cancelled = false;
  const discard = (f) => { try { fs.unlink(f, () => {}); } catch (_) {} };
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelled = true;
      files.splice(0).forEach(discard);   // لا تسرّب ملفات عند فوز المهلة
      reject(new Error("تجاوز العملية الوقت المسموح (3 دقائق)"));
    }, TOTAL_TIMEOUT_MS);
  });
  const workPromise = (async () => {
    for (let i = 0; i < SEEDS.length; i++) {
      if (cancelled) break;
      onProgress(i);
      if (i > 0) await DELAY(1_500);
      if (cancelled) break;
      const f = await downloadImage(prompt, model, dims, SEEDS[i], i);
      if (cancelled) { discard(f); break; }   // انتهى بعد المهلة
      files.push(f);
    }
    return files;
  })();
  workPromise.catch(() => {});                 // لا unhandled rejection إن خسر السباق
  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } catch (e) {
    cancelled = true;
    files.splice(0).forEach(discard);          // فشل عادي: نظّف ما نُزِّل
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}
function parseArgs(args) {
  const rest = [...args];
  let model = "flux", ratio = "1:1", styleTag = null;
  if (MODELS[rest[0]?.toLowerCase()])  model    = MODELS[rest.shift().toLowerCase()];
  if (RATIOS[rest[0]])                 ratio    = rest.shift();
  if (STYLES[rest[0]?.toLowerCase()])  styleTag = rest.shift().toLowerCase();
  return { model, ratio, styleTag, rawPrompt: rest.join(" ").trim() };
}
export default {
  config: {
    name:        "draw",
    aliases:     ["flux"],
    version:     "2.2.0",
    role:        0,
    countDown:   20,
    category:    "ذكاء اصطناعي",
    description: "توليد 4 صور بالذكاء الاصطناعي — FLUX (Pollinations.ai) أو ArtX (Toshiro Editz)",
    usage: [
      "{pn}draw <وصف>",
      "{pn}draw flux-realism <وصف>",
      "{pn}draw turbo <وصف>",
      "{pn}draw artx <وصف>",
      "{pn}draw 16:9 <وصف>",
      "{pn}draw anime <وصف>",
      "{pn}draw help",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID } = event;
    if (!args[0] || args[0].toLowerCase() === "help") {
      return message.reply(
        "🖼️ توليد الصور بالذكاء الاصطناعي\n" +
        "━━━━━━━━━━━━━━━━━\n\n" +
        "🤖 النماذج:\n" +
        "  flux          — الافتراضي (Pollinations)\n" +
        "  flux-realism  — أكثر واقعية\n" +
        "  turbo         — الأسرع\n" +
        "  gptimage      — نمط GPT-4o\n" +
        "  artx          — محرك ArtX (Toshiro Editz) — أسرع، طلب واحد فقط\n\n" +
        "📐 النسب (لا تنطبق على artx):\n  " + Object.keys(RATIOS).join(" · ") + "\n\n" +
        "🎭 الأنماط:\n  " + Object.keys(STYLES).join(" · ") + "\n\n" +
        "📝 أمثلة:\n" +
        "  draw dragon over neon city\n" +
        "  draw flux-realism 16:9 mountain at sunrise\n" +
        "  draw anime فتاة تحت المطر في طوكيو\n" +
        "  draw artx cyberpunk cat\n\n" +
        "🆓 مجاني — لا تسجيل ولا API key"
      );
    }
    const { model, ratio, styleTag, rawPrompt } = parseArgs(args);
    if (!rawPrompt) return message.reply("❓ اكتب وصف الصورة بعد الأمر.");
    let englishPrompt = await translateToEnglish(rawPrompt).catch(() => rawPrompt);
    if (styleTag) englishPrompt = `${englishPrompt}, ${STYLES[styleTag]}`;

    // ─── محرك ArtX: طلب واحد، بدون نسب/seeds ───
    if (model === "artx") {
      const statusMsg = await new Promise((res, rej) =>
        global.safeSend(api,
          `🎨 جاري التوليد (ArtX)...\n📝 ${rawPrompt.substring(0, 60)}`,
          threadID, (e, i) => e ? rej(e) : res(i), messageID)
      ).catch(() => null);
      let tmpFiles = [];
      try {
        tmpFiles = await downloadArtx(englishPrompt);
        if (statusMsg?.messageID) api.unsendMessage(statusMsg.messageID, threadID).catch(() => {});
        const caption = [
          `🖼️ ArtX (Toshiro Editz) · ${tmpFiles.length} صورة`,
          `📝 ${rawPrompt.substring(0, 80)}`,
          englishPrompt.trim().toLowerCase() !== rawPrompt.trim().toLowerCase()
            ? `🌐 ${englishPrompt.substring(0, 80)}`
            : null,
          styleTag ? `🎭 ${styleTag}` : null,
        ].filter(Boolean).join("\n");
        await new Promise((resolve, reject) =>
          global.safeSend(api,
            { body: caption, attachment: tmpFiles.map(f => fs.createReadStream(f)) },
            threadID, err => err ? reject(err) : resolve(), messageID)
        );
      } catch (err) {
        console.error("[DRAW:artx]", err.message);
        if (statusMsg?.messageID) api.unsendMessage(statusMsg.messageID, threadID).catch(() => {});
        const errMsg = err?.status === 429
          ? "❌ خادم ArtX مشغول (429) — انتظر دقيقة وحاول مجدداً."
          : `❌ فشل توليد الصورة عبر ArtX: ${err.message?.substring(0, 100)}\nحاول مجدداً أو استخدم محركاً آخر (draw flux ...).`;
        message.reply(errMsg);
      } finally {
        await Promise.allSettled(tmpFiles.map(f => fs.remove(f)));
      }
      return;
    }

    // ─── محرك Pollinations (flux/turbo/...) — التدفق الأصلي ───
    const dims = RATIOS[ratio];
    const statusMsg = await new Promise((res, rej) =>
      global.safeSend(api,
        `🎨 جاري التوليد (${model} · ${ratio})...\n` +
        `📝 ${rawPrompt.substring(0, 60)}\n` +
        `⏳ صورة 1/4 — يستغرق 30–60 ثانية`,
        threadID, (e, i) => e ? rej(e) : res(i), messageID)
    ).catch(() => null);
    const editStatus = (text) => {
      try { if (statusMsg?.messageID) api.editMessage(text, statusMsg.messageID); }
      catch (_) {}
    };
    let tmpFiles = [];
    try {
      tmpFiles = await downloadAllSequential(
        englishPrompt, model, dims,
        (i) => editStatus(
          `🎨 جاري التوليد (${model} · ${ratio})...\n` +
          `📝 ${rawPrompt.substring(0, 60)}\n` +
          `⏳ صورة ${i + 1}/4...`
        )
      );
      if (statusMsg?.messageID) api.unsendMessage(statusMsg.messageID, threadID).catch(() => {});
      const caption = [
        `🖼️ FLUX (${model}) · ${ratio}`,
        `📝 ${rawPrompt.substring(0, 80)}`,
        englishPrompt.trim().toLowerCase() !== rawPrompt.trim().toLowerCase()
          ? `🌐 ${englishPrompt.substring(0, 80)}`
          : null,
        styleTag ? `🎭 ${styleTag}` : null,
      ].filter(Boolean).join("\n");
      await new Promise((resolve, reject) =>
        global.safeSend(api,
          { body: caption, attachment: tmpFiles.map(f => fs.createReadStream(f)) },
          threadID, err => err ? reject(err) : resolve(), messageID)
      );
    } catch (err) {
      console.error("[DRAW]", err.message);
      if (statusMsg?.messageID) api.unsendMessage(statusMsg.messageID, threadID).catch(() => {});
      const errMsg = err?.status === 429
        ? "❌ الخادم مشغول (429) — انتظر دقيقة وحاول مجدداً."
        : `❌ فشل التوليد: ${err.message?.substring(0, 100)}\nحاول مجدداً.`;
      message.reply(errMsg);
    } finally {
      await Promise.allSettled(tmpFiles.map(f => fs.remove(f)));
    }
  },
};
