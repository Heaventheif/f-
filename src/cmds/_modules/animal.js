import http from "../../utils/fetchHttp.js";
import { translateTextStrict } from "../../utils/translator.js";
const STATIC_FACTS = {
  cat: [
    "القطط تقضي ما بين 12 و16 ساعة يوميًا في النوم.",
    "لا تستطيع القطط تذوق النكهة الحلوة.",
    "يمكن للقطة أن تدير أذنيها بزاوية 180 درجة.",
    "القطط تصدر الخرخرة للتعبير عن الراحة وأحيانًا لتهدئة نفسها.",
  ],
  dog: [
    "حاسة الشم عند الكلاب أقوى من حاسة الإنسان بآلاف المرات.",
    "الكلاب تفهم مئات الكلمات والإشارات.",
    "بصمة أنف الكلب فريدة مثل بصمة إصبع الإنسان.",
    "الكلاب تحرّك ذيلها يمينًا عند السعادة ويسارًا عند التوتر غالبًا.",
  ],
};
const EMOJI = { cat: "🐱", dog: "🐶" };
const LABEL = { cat: "حقيقة عن القطط", dog: "حقيقة عن الكلاب" };
export const staticFact = (type, rnd = Math.random) => {
  const list = STATIC_FACTS[type] || STATIC_FACTS.cat;
  return list[Math.floor(rnd() * list.length)];
};
const CAT_TRIGGERS = ["قط", "قطة"];
const DOG_TRIGGERS = ["كلب"];
async function getCatFact() {
  const res = await http.get("https://catfact.ninja/fact", { timeout: 8e3 });
  const fact = res.data?.fact;
  if (!fact) throw new Error("لا توجد بيانات");
  return { emoji: "🐱", label: "حقيقة عن القطط", fact };
}
async function getDogFact() {
  try {
    const res2 = await http.get("https://dogapi.dog/api/v2/facts", { timeout: 6e3 });
    const fact2 = res2.data?.data?.[0]?.attributes?.body;
    if (fact2) return { emoji: "🐶", label: "حقيقة عن الكلاب", fact: fact2 };
  } catch (_) {}
  const res = await http.get("https://dog-api.kinduff.com/api/facts", { timeout: 8e3 });
  const fact = res.data?.facts?.[0];
  if (!fact) throw new Error("لا توجد بيانات");
  return { emoji: "🐶", label: "حقيقة عن الكلاب", fact };
}
async function sendFact(api, threadID, messageID, type) {
  let fact;
  let live = true;
  try {
    ({ fact } = type === "dog" ? await getDogFact() : await getCatFact());
  } catch (error) {
    // both APIs down: serve a built-in Arabic fact instead of failing
    console.warn("[ANIMAL] API failed, static fallback:", error?.message || error);
    fact = staticFact(type);
    live = false;
  }
  let text = fact;
  if (live) {
    try {
      const translated = await translateTextStrict(fact, "ar");
      if (!translated?.trim()) throw new Error("empty translation");
      text = translated.trim();
    } catch (error) {
      console.warn("[ANIMAL] translation failed, sending English:", error?.message || error);
      text = `${fact}\n(تعذّرت الترجمة)`;
    }
  }
  await global.safeSend(api, `${EMOJI[type]} ${LABEL[type]}\n\n${text}`, threadID, null, messageID);
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
    const firstWord =
      (body || "")
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
  },
};
