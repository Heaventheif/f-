"use strict";

import { resolveCommandId, setCommandDisabled, setGroupPaused } from "../utils/groupControl.js";

const config = {
  name: "off",
  aliases: ["on"],
  version: "1.0.0",
  role: 2,
  countDown: 0,
  groupOnly: true,
  category: "admin",
  description: "تعطيل أمر أو إيقاف البوت في المجموعة الحالية",
  usage: ["{pn}off <command>", "{pn}on <command>", "{pn}off bot", "{pn}on bot"]
};

function reply(api, event, text) {
  return api.sendMessage(text, event.threadID, null, event.messageID);
}

function persistenceNote(persisted) {
  return persisted ? "" : "\n⚠️ تعذّر حفظ الحالة على القرص؛ ستظل فعالة في الذاكرة حتى إعادة تشغيل البوت.";
}

async function run({ api, event, args = [] }) {
  const action = String(event?.command ?? "").trim().toLowerCase();
  const threadID = event?.threadID == null ? "" : String(event.threadID).trim();
  const senderID = event?.senderID;
  const botIndex = api?.__botIndex ?? null;
  if (event?.isGroup !== true || !threadID || senderID == null || !["off", "on"].includes(action)) {
    return reply(api, event, "⚠️ لا يمكن تنفيذ هذا الأمر هنا.");
  }
  if ((global.getUserRole?.(senderID, botIndex) ?? 0) < 2) {
    return reply(api, event, "⛔ ليس لديك صلاحية تنفيذ هذا الإجراء.");
  }
  if (args.length !== 1 || !String(args[0] ?? "").trim()) {
    return reply(api, event, "الاستخدام: off <command> | on <command> | off bot | on bot");
  }

  const target = String(args[0]).trim().toLowerCase();
  if (target === "bot") {
    const result = await setGroupPaused(threadID, action === "off");
    if (!result.changed) {
      return reply(api, event, action === "off"
        ? "ℹ️ البوت متوقف بالفعل في هذه المجموعة."
        : "ℹ️ البوت يعمل بالفعل في هذه المجموعة.");
    }
    const message = action === "off"
      ? "⏸️ تم إيقاف البوت في هذه المجموعة."
      : "▶️ تمت إعادة تشغيل البوت في هذه المجموعة.";
    return reply(api, event, message + persistenceNote(result.persisted));
  }

  const resolved = resolveCommandId(target);
  if (!resolved) return reply(api, event, `❓ الأمر «${target}» غير موجود.`);
  if (resolved.id === "off" || resolved.command === global.commands?.get("off")) {
    return reply(api, event, "⚠️ لا يمكن تعطيل أوامر التحكم off/on.");
  }

  const result = await setCommandDisabled(threadID, resolved.id, action === "off");
  if (!result.changed) {
    return reply(api, event, action === "off"
      ? `ℹ️ الأمر «${resolved.id}» معطّل مسبقاً في هذه المجموعة.`
      : `ℹ️ الأمر «${resolved.id}» مفعّل بالفعل في هذه المجموعة.`);
  }
  const message = action === "off"
    ? `⛔ تم تعطيل الأمر «${resolved.id}» في هذه المجموعة.`
    : `✅ تم تفعيل الأمر «${resolved.id}» في هذه المجموعة.`;
  return reply(api, event, message + persistenceNote(result.persisted));
}

export default { config, run };
