import { getFahimFact } from "../../utils/fahimProviders.js";
import { toArabicOutput } from "../../utils/arabicOutput.js";

export default {
  config: {
    name: "fact",
    aliases: ["معلومة"],
    version: "1.0.0",
    role: 0,
    countDown: 5,
    category: "ألعاب وترفيه",
    description: "يعرض معلومة عامة عشوائية باللغة العربية",
    usage: ["{pn}fact — معلومة عشوائية", "{pn}معلومة — نفس الأمر بالعربية"],
  },
  onStart: async ({ message }) => {
    try {
      const fact = await toArabicOutput(await getFahimFact());
      return message.reply(`💡 معلومة:\n${fact}`);
    } catch (error) {
      console.warn("[FACT] تعذر جلب المعلومة:", error.message);
      return message.reply("تعذر جلب معلومة عربية الآن؛ حاول مرة أخرى لاحقاً.");
    }
  },
};
