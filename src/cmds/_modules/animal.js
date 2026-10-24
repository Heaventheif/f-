import http from "../../utils/fetchHttp.js";
import { translateToArabic  } from "../../utils/translator.js";
const CAT_TRIGGERS = ["قط", "قطة"];
const DOG_TRIGGERS = ["كلب"];
async function getCatFact() {
  const res  = await http.get("https://catfact.ninja/fact", { timeout: 8000 });
  const fact = res.data?.fact;
  if (!fact) throw new Error("لا توجد بيانات");
  return { emoji: "🐱", label: "حقيقة عن القطط", fact };
}
async function getDogFact() {
  try {
    const res  = await http.get("https://dogapi.dog/api/v2/facts", { timeout: 6000 });
    const fact = res.data?.data?.[0]?.attributes?.body;
    if (fact) return { emoji: "🐶", label: "حقيقة عن الكلاب", fact };
  } catch (_) {  }
  const res  = await http.get("https://dog-api.kinduff.com/api/facts", { timeout: 8000 });
  const fact = res.data?.facts?.[0];
  if (!fact) throw new Error("لا توجد بيانات");
  return { emoji: "🐶", label: "حقيقة عن الكلاب", fact };
}
async function sendFact(api, threadID, messageID, type) {
  try {
    const { emoji, label, fact } = type === "dog" ? await getDogFact() : await getCatFact();
    const translated = await translateToArabic(fact);
    global.safeSend(api, `${emoji} ${label}\n\n${translated}`, threadID, null, messageID);
  } catch {
    global.safeSend(api, "❌ فشل جلب الحقيقة — حاول مرة أخرى", threadID, null, messageID);
  }
}
export default {
  config: {
    name: "animal",
    aliases: ["حيوان", ...CAT_TRIGGERS, ...DOG_TRIGGERS],
    version: "1.0.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    category: "ألعاب وترفيه",
    description: "حقيقة عشوائية عن القطط أو الكلاب 🐱🐶",
    usage: [
      "{pn}قط — حقيقة عن القطط",
      "{pn}كلب — حقيقة عن الكلاب",
      "{pn}حيوان قط — حقيقة عن القطط",
      "{pn}حيوان كلب — حقيقة عن الكلاب",
      "{pn}حيوان — يختار عشوائياً بين قطة وكلب",
    ],
  },
  onStart: async function ({ api, event, args }) {
    const { threadID, messageID, body } = event;
    const firstWord = (body || "")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/^[^a-zA-Z\u0600-\u06FF]+/, "") || "";
    if (DOG_TRIGGERS.includes(firstWord)) return sendFact(api, threadID, messageID, "dog");
    if (CAT_TRIGGERS.includes(firstWord)) return sendFact(api, threadID, messageID, "cat");
    const sub = (args[0] || "").toLowerCase();
    if (DOG_TRIGGERS.includes(sub)) return sendFact(api, threadID, messageID, "dog");
    if (CAT_TRIGGERS.includes(sub)) return sendFact(api, threadID, messageID, "cat");
    return sendFact(api, threadID, messageID, Math.random() < 0.5 ? "cat" : "dog");
  }
};
