import { translateTextStrict } from "../utils/translator.js";
import { chunkText } from "../ai/text.js";

const MAX_CHARS = 5000;
const CODES = (
  "ar en fr es de it pt ru zh zh-cn zh-tw ja ko tr nl pl sv fi da no el he hi ur fa id ms th vi ro hu cs sk uk bg sr hr sl lt lv et az ka am sw bn ta te ml mr gu pa ne si km lo my mn kk uz tg ps ku yo ig ha zu xh af sq hy eu be bs ca cy eo fy ga gl is jw kn la lb mg mi mk mt ny or rw sd sm sn so st su tl tt ug yi"
).split(" ");
const CANON = { zh: "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW" };
const NAMES = {
  english: "en", انجليزي: "en", انجليزية: "en", إنجليزي: "en", إنجليزية: "en", انكليزي: "en",
  arabic: "ar", عربي: "ar", عربية: "ar",
  french: "fr", فرنسي: "fr", فرنسية: "fr",
  spanish: "es", اسباني: "es", إسباني: "es", اسبانية: "es",
  german: "de", الماني: "de", ألماني: "de", المانية: "de",
  italian: "it", ايطالي: "it", إيطالي: "it", ايطالية: "it",
  portuguese: "pt", برتغالي: "pt", برتغالية: "pt",
  russian: "ru", روسي: "ru", روسية: "ru",
  chinese: "zh-CN", صيني: "zh-CN", صينية: "zh-CN",
  japanese: "ja", ياباني: "ja", يابانية: "ja",
  korean: "ko", كوري: "ko", كورية: "ko",
  turkish: "tr", تركي: "tr", تركية: "tr",
  hindi: "hi", هندي: "hi", هندية: "hi",
  urdu: "ur", اردو: "ur", أردو: "ur",
  persian: "fa", farsi: "fa", فارسي: "fa", فارسية: "fa",
  dutch: "nl", هولندي: "nl", hebrew: "he", عبري: "he", عبرية: "he",
  indonesian: "id", اندونيسي: "id", greek: "el", يوناني: "el",
};
const USAGE = "الاستخدام:\ntr en: <النص>\ntr -fr <النص>\nرد على رسالة + tr en";

// Returns the canonical language code or null.
export function resolveLang(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(NAMES, t)) return NAMES[t];
  if (CODES.includes(t)) return CANON[t] || t;
  return null;
}
const isArabicText = (s) => {
  const letters = s.match(/\p{L}/gu) || [];
  const ar = s.match(/[؀-ۿ]/g) || [];
  return letters.length > 0 && ar.length > letters.length * 0.5;
};
const defaultTarget = (text) => (isArabicText(text) ? "en" : "ar");

// Pure parser. `tr no way` / `tr it is cold` are plain text (never a language).
// A language must be explicit: `en: text`, `-en text`, or the sole arg when replying.
export function parseTrArgs(args, replyBody = "") {
  const reply = String(replyBody || "").trim();
  const list = (args || []).map(String);
  if (!list.length) return reply ? { lang: defaultTarget(reply), text: reply } : { error: USAGE };
  const joined = list.join(" ").trim();
  let lang = null;
  let rest = null;
  const flag = list[0].match(/^-([\p{L}-]{2,12})$/u);
  const colon = joined.match(/^([\p{L}-]{2,12})\s*:\s*([\s\S]*)$/u);
  if (flag) {
    lang = resolveLang(flag[1]);
    if (!lang) return { error: `لغة غير معروفة: ${flag[1]}` };
    rest = list.slice(1).join(" ").trim();
  } else if (colon && resolveLang(colon[1])) {
    lang = resolveLang(colon[1]);
    rest = colon[2].trim();
  } else if (list.length === 1 && reply && resolveLang(list[0])) {
    lang = resolveLang(list[0]);
    rest = "";
  }
  if (lang) {
    const text = rest || reply;
    return text ? { lang, text } : { error: USAGE };
  }
  return { lang: defaultTarget(joined), text: joined };
}

export default {
  config: {
    name: "tr",
    description: "ترجمة النص إلى أي لغة",
    usage: [
      "{pn}tr <النص> — يترجم للعربية (والنص العربي يُترجم للإنجليزية)",
      "{pn}tr en: <النص> أو {pn}tr -en <النص> — تحديد اللغة (رمز أو اسم: فرنسي، english...)",
      "رد على رسالة + {pn}tr en — ترجمة الرسالة المردود عليها",
    ],
    aliases: ["ترجم"],
    category: "أدوات عامة",
    role: 0,
    countDown: 5,
    nonPrefix: true,
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID, messageReply } = event;
    const send = (t) => global.safeSend(api, t, threadID, null, messageID);
    const parsed = parseTrArgs(args, messageReply?.body);
    if (parsed.error) return send(parsed.error);
    if (parsed.text.length > MAX_CHARS) return send(`النص طويل جداً؛ الحد الأقصى ${MAX_CHARS} حرف.`);
    try {
      const out = (await translateTextStrict(parsed.text, parsed.lang))?.trim();
      if (!out) throw new Error("empty");
      for (const part of chunkText(out, 1800)) await send(part);
    } catch (e) {
      console.error("[TR]", e?.message || e);
      await send("تعذرت الترجمة الآن؛ يرجى المحاولة مرة أخرى لاحقاً.");
    }
  },
};
