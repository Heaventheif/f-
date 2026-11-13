"use strict";
import { validateUserId } from "../../utils/betadash.js";
import { createBetadashCommand } from "../../media/betadashCommand.js";

export const DESIGNS = [
  { name: "slapv2", label: "👊 Slap V2", params: (one, two) => ({ one, two }) },
  { name: "slap", label: "🦇 Slap", params: (one, two) => ({ batman: one, superman: two }) },
  { name: "spank", label: "🍑 Spank", params: (one, two) => ({ uid1: one, uid2: two }) },
];
export const parseSlapArgs = (args = []) => {
  const values = [...args];
  if (values[0]?.toLowerCase() === "list" || values[0] === "قائمة") return { list: true };
  const design = DESIGNS.some((d) => d.name === values[0]?.toLowerCase()) ? values.shift().toLowerCase() : null;
  return { design, target: values.find((v) => /^\d{5,20}$/.test(v)) || null };
};

export default createBetadashCommand({
  config: {
    name: "slap",
    aliases: ["صفعة", "سلاب"],
    version: "3.0.0",
    role: 0,
    countDown: 12,
    category: "ألعاب وترفيه",
    description: "صورة تفاعلية بين شخصين عبر Betadash مع بدائل تلقائية",
    usage: ["رد على رسالة + {pn}slap", "{pn}slap @منشن", "{pn}slap slapv2 @منشن", "{pn}slap list"],
  },
  designs: DESIGNS,
  indexKey: "betadash_slap_index",
  tag: "slap",
  parseArgs: parseSlapArgs,
  listText: `👊 التصاميم: ${DESIGNS.map((d) => d.name).join(" · ")}\nاستخدم slap أو slap <design> مع منشن/رد.`,
  prepare: async ({ event, parsed, design }) => {
    const one = validateUserId(event.senderID);
    // self-slap is allowed when the sender is explicitly targeted (mention/reply/uid)
    const two = validateUserId(Object.keys(event.mentions || {})[0] || event.messageReply?.senderID || parsed.target);
    if (!one || !two) return { error: "⚠️ حدد الشخص الثاني بمنشن أو رد على رسالته أو UID صحيح." };
    const ordered = [design, ...DESIGNS.filter((d) => d.name !== design.name)];
    return { candidates: ordered.map((d) => ({ endpoint: d.name, params: d.params(one, two) })) };
  },
});
