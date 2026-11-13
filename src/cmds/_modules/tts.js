"use strict";
import { createReadStream } from "node:fs";
import { KeyedMutex } from "../../infra/limiter.js";
import { LRU } from "../../infra/lru.js";
import { getStore } from "../../state/kv.js";
import { withTempDir, writeTmp } from "../../io/tmp.js";
import { hfPost, hfGet } from "../../ai/hf.js";

const DEFAULT_VOICE = "noura";
const MAX_CHARS = 500;
const VOICE_CACHE_MS = 5 * 60 * 1e3;
let _voicesCache = null;
let _voicesCacheUntil = 0;

const hasArabicText = (text) => /[\u0600-\u06FF\u0750-\u077F]/u.test(text);
function voiceId(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") return String(value.id ?? value.voice_id ?? value.name ?? value.voice ?? "").trim();
  return "";
}

async function fetchVoices() {
  if (_voicesCache && Date.now() < _voicesCacheUntil) return _voicesCache;
  const data = await hfGet("/gemini/tts/voices", { timeoutMs: 15_000 });
  const result = {
    groq_voices: Array.isArray(data?.groq_voices) ? data.groq_voices : [],
    piper_voices: Array.isArray(data?.piper_voices) ? data.piper_voices : [],
  };
  if (!result.groq_voices.length && !result.piper_voices.length) throw new Error("empty voices");
  _voicesCache = result;
  _voicesCacheUntil = Date.now() + VOICE_CACHE_MS;
  return result;
}

// Voice preferences: one record per thread in the kv store, updated atomically.
// Keys are prefixed so a hostile id like "__proto__" can never touch prototypes.
// The RAM map is a bounded fallback used only when the store is unavailable.
export function createPrefs(getNs, mutex = new KeyedMutex()) {
  const ram = new LRU({ maxEntries: 1000, maxBytes: 1024 * 1024 });
  const k = (id) => `u:${String(id)}`;
  const tk = (t) => String(t);
  async function mutate(threadID, fn) {
    return mutex.run(tk(threadID), async () => {
      try {
        const ns = await getNs();
        const next = await ns.update(tk(threadID), (cur) => fn({ ...(cur || {}) }), {});
        ram.set(tk(threadID), next);
        return { persisted: true };
      } catch (e) {
        console.warn("[tts:prefs] store failed, RAM only:", e?.message || e);
        ram.set(tk(threadID), fn({ ...(ram.get(tk(threadID)) || {}) }));
        return { persisted: false };
      }
    });
  }
  return {
    async get(threadID, senderID) {
      let rec;
      try {
        rec = await (await getNs()).get(tk(threadID));
      } catch {
        rec = ram.get(tk(threadID));
      }
      const v = rec && Object.prototype.hasOwnProperty.call(rec, k(senderID)) ? String(rec[k(senderID)] || "").trim() : "";
      return v ? { voice: v, source: "pinned" } : { voice: DEFAULT_VOICE, source: "default" };
    },
    set: (threadID, senderID, voice) => mutate(threadID, (r) => ({ ...r, [k(senderID)]: voice })),
    reset: (threadID, senderID) =>
      mutate(threadID, (r) => {
        delete r[k(senderID)];
        return r;
      }),
  };
}
const prefs = createPrefs(async () => (await getStore()).ns("tts_prefs"));

function formatVoices(data) {
  const groq = data.groq_voices.map(voiceId).filter(Boolean);
  const piper = data.piper_voices.map(voiceId).filter(Boolean);
  const list = (a) => (a.length ? a.map((n) => `• ${n}`).join("\n") : "غير متاح حالياً");
  return `🎙️ أصوات TTS المتاحة\n\nGroq:\n${list(groq)}\n\nPiper:\n${list(piper)}\n\nالافتراضي: ${DEFAULT_VOICE}\nلتثبيت صوت: .tts set <voice-id>`;
}

export default {
  config: {
    name: "tts",
    aliases: ["قول"],
    version: "4.0.0",
    role: 0,
    countDown: 8,
    category: "ذكاء اصطناعي",
    description: "تحويل النص العربي إلى صوت، مع صوت قابل للتثبيت لكل مستخدم في المجموعة",
    usage: [
      "{pn}tts <نص عربي (حتى 500 حرف)> — يستخدم صوتك المثبّت أو noura افتراضياً",
      "{pn}tts set <voice-id> — تثبيت الصوت لك في هذه المجموعة",
      "{pn}tts show — عرض الصوت ومصدره",
      "{pn}tts reset — حذف صوتك المثبّت",
      "{pn}tts voices — عرض أصوات Groq وPiper",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID, senderID } = event;
    const raw = (args || []).join(" ").trim();
    const reply = (t) => message.reply(t);
    if (!threadID || !senderID) return reply("❌ تعذّر تحديد المجموعة أو المستخدم.");
    const action = (args?.[0] || "").toLowerCase();
    if (action === "voices" || action === "أصوات") {
      try {
        return await reply(formatVoices(await fetchVoices()));
      } catch (e) {
        console.error("[tts:voices]", e?.message);
        return reply("❌ تعذّر جلب قائمة أصوات TTS، حاول لاحقاً.");
      }
    }
    if (action === "set") {
      const requested = String(args?.[1] || "").trim();
      if (!requested || args.length !== 2) return reply("❓ الاستخدام: .tts set <voice-id>");
      try {
        const data = await fetchVoices();
        const match = [...data.groq_voices, ...data.piper_voices].find((v) => voiceId(v).toLowerCase() === requested.toLowerCase());
        if (!match) return reply(`❌ الصوت «${requested}» غير موجود. استخدم .tts voices لعرض الأصوات.`);
        const selected = voiceId(match);
        const { persisted } = await prefs.set(threadID, senderID, selected);
        return reply(`✅ ثُبّت الصوت «${selected}» لك في هذه المجموعة.` + (persisted ? "" : "\n⚠️ لم يُحفظ دائماً؛ سيُفقد عند إعادة التشغيل."));
      } catch (e) {
        console.error("[tts:set]", e?.message);
        return reply("❌ تعذّر التحقق من الصوت أو حفظه، حاول لاحقاً.");
      }
    }
    if (action === "show") {
      const cur = await prefs.get(threadID, senderID);
      return reply(`🎙️ الصوت الحالي: ${cur.voice}\nالمصدر: ${cur.source === "pinned" ? "مثبّت لك في هذه المجموعة" : "الافتراضي"}`);
    }
    if (action === "reset") {
      try {
        await prefs.reset(threadID, senderID);
        return reply(`🔄 حُذف تثبيت صوتك. سيُستخدم ${DEFAULT_VOICE} افتراضياً.`);
      } catch (e) {
        console.error("[tts:reset]", e?.message);
        return reply("❌ تعذّر حذف تثبيت الصوت، حاول لاحقاً.");
      }
    }
    if (!raw)
      return reply("🗣️ أرسل نصاً عربياً. استخدم .tts set <voice-id> لاختيار صوتك، و.tts voices لعرض القائمة.");
    if (raw.length > MAX_CHARS) return reply(`❌ النص طويل جداً؛ الحد الأقصى ${MAX_CHARS} حرف.`);
    if (!hasArabicText(raw)) return reply("❌ خدمة TTS في هذا الأمر تدعم النص العربي فقط.");
    try {
      const cur = await prefs.get(threadID, senderID);
      const data = await hfPost("/gemini/tts", { text: raw, voice: cur.voice }, { timeoutMs: 120_000 });
      if (!data?.audio_base64) throw Object.assign(new Error(data?.error || "empty"), { status: 502 });
      const used = String(data.usedVoice ?? data.used_voice ?? data.voice ?? cur.voice).trim() || cur.voice;
      const buffer = Buffer.from(data.audio_base64, "base64");
      await withTempDir(async (dir) => {
        const file = await writeTmp(dir, buffer, "wav");
        await global.safeSend(api, { body: `🎙️ ${used}`, attachment: createReadStream(file) }, threadID, null, messageID);
      }, "tts");
    } catch (e) {
      console.error("[TTS]", e?.status || e?.code, String(e?.message).slice(0, 200));
      const hint = [500, 502, 503, 504].includes(e?.status) ? " أعد المحاولة بعد قليل." : "";
      await reply(`❌ فشل توليد الصوت${e?.status ? ` (HTTP ${e.status})` : ""}.${hint}`).catch(() => {});
    }
  },
};
