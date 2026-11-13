// Pure permission check: the original requester, a group admin or a bot admin may delete.
export function canUnsend({ senderID, requesterID = null, role = 0, isGroupAdmin = false }) {
  if (Number(role) >= 1 || isGroupAdmin) return true;
  return requesterID != null && String(requesterID) === String(senderID);
}
// Errors are classified by their code, never by message text.
export function unsendErrorKey(e) {
  const code = String(e?.code ?? e?.errorCode ?? "").toUpperCase();
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || e?.code === "timeout") return "network";
  if (["MESSAGE_TOO_OLD", "TOO_OLD", "NOT_FOUND", "1545012"].includes(code) || String(e?.error) === "1545012")
    return "gone";
  return "unknown";
}
const ERR_TEXT = {
  network: "🌐 مشكلة اتصال، حاول مجدداً.",
  gone: "⏰ الرسالة قديمة جداً أو محذوفة مسبقاً.",
  unknown: "💡 لم يسمح فيسبوك بحذف هذه الرسالة.",
};

export default {
  config: {
    name: "unsend",
    aliases: ["حذف", "احذف"],
    version: "2.0.0",
    author: "sunken",
    countDown: 3,
    role: 0,
    nonPrefix: true,
    category: "أدوات عامة",
    description: "حذف رسائل البوت عن طريق الرد عليها (لصاحب الطلب أو المشرفين)",
    usage: ["رد على رسالة البوت + {pn}احذف — يحذف تلك الرسالة"],
  },
  onStart: async function ({ api, event, message, role, isGroupAdmin }) {
    const { threadID, senderID, type, messageReply } = event;
    const commandMessageID = event.commandMessageID ?? event.messageID;
    if (type !== "message_reply" || !messageReply) {
      return message.reply("⚠️ طريقة الاستخدام:\n1️⃣ اضغط مطولاً على رسالة البوت\n2️⃣ اختر 'رد' (Reply)\n3️⃣ اكتب: unsend أو حذف");
    }
    const botID = api.getCurrentUserID();
    if (String(messageReply.senderID) !== String(botID)) {
      return message.reply("❌ لا يمكنني حذف رسائل الأعضاء الآخرين.\n💡 يمكنني فقط سحب الرسائل التي أرسلتها أنا.");
    }
    const requesterID = global.Kagenou?.replies?.[String(messageReply.messageID)]?.author ?? null;
    if (!canUnsend({ senderID, requesterID, role, isGroupAdmin })) {
      return message.reply("⛔ يمكن فقط لصاحب الطلب أو المشرفين حذف هذه الرسالة.");
    }
    try {
      await api.unsendMessage(messageReply.messageID);
    } catch (e) {
      console.error("[UNSEND]", threadID, e?.code ?? e?.error ?? e?.message);
      return message.reply(`❌ تعذر حذف الرسالة.\n${ERR_TEXT[unsendErrorKey(e)]}`);
    }
    if (commandMessageID) await api.unsendMessage(commandMessageID).catch(() => {});
  },
};
