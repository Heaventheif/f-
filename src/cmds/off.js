"use strict";

import { setBotOff, setCommandOff, commandKey } from "../utils/offState.js";

const CONTROL = new Set(["off", "on"]); // لا يجوز تعطيل أوامر التحكم نفسها (قفل ذاتي)
const NOT_SAVED = "\n⚠️ لم تُحفظ الحالة؛ ستُفقد عند إعادة تشغيل البوت.";

function build(action) {
  const off = action === "off";
  const other = off ? "on" : "off";
  return {
    config: {
      name: action,
      version: "1.0.0",
      author: "SunkenBot",
      countDown: 1,
      role: 2,
      groupOnly: true,
      category: "admin",
      description: off
        ? "تعطيل أمر داخل هذه المجموعة فقط، أو إيقاف البوت فيها بالكامل (off bot)"
        : "إعادة تفعيل أمر داخل هذه المجموعة فقط، أو إعادة تشغيل البوت فيها (on bot)",
      guide: { ar: `{pn}${action} <أمر>\n{pn}${action} bot` },
    },

    async onStart({ event, args, role, message, prefix }) {
      const reply = (t) => message.reply(t);
      const threadID = event?.threadID;

      if (!event?.isGroup || !threadID) return reply("⚠️ هذا الأمر يعمل داخل المجموعات فقط.");
      if ((role ?? 0) < 2) return reply("⛔ ليس لديك صلاحية تنفيذ هذا الإجراء.");

      const usage = `❓ الاستخدام:\n${prefix || ""}${action} <أمر>\n${prefix || ""}${action} bot`;
      if (args.length !== 1) return reply(usage);
      const target = String(args[0]).trim().toLowerCase();
      if (!target) return reply(usage);

      if (target === "bot") {
        const { changed, persisted } = await setBotOff(threadID, off);
        if (!changed) {
          return reply(off ? "ℹ️ البوت موقوف بالفعل في هذه المجموعة." : "ℹ️ البوت يعمل بالفعل في هذه المجموعة.");
        }
        return reply((off ? "🔕 تم إيقاف البوت في هذه المجموعة.\nللاستعادة: on bot" : "🔔 تمت إعادة تشغيل البوت في هذه المجموعة.") +
          (persisted ? "" : NOT_SAVED));
      }

      const command = global.commands?.get(target);
      const key = commandKey(command);
      if (!command || !key) return reply(`❓ الأمر «${target}» غير موجود.`);
      if (CONTROL.has(key)) return reply(`⚠️ لا يمكن ${off ? "تعطيل" : "تفعيل"} أوامر التحكم (${action}/${other}).`);

      const { changed, persisted } = await setCommandOff(threadID, key, off);
      if (!changed) {
        return reply(off ? `ℹ️ الأمر «${key}» معطّل مسبقًا في هذه المجموعة.` : `ℹ️ الأمر «${key}» مفعّل بالفعل في هذه المجموعة.`);
      }
      return reply((off ? `🚫 تم تعطيل الأمر «${key}» في هذه المجموعة.` : `✅ تم تفعيل الأمر «${key}» في هذه المجموعة.`) +
        (persisted ? "" : NOT_SAVED));
    },
  };
}

export const commands = [build("off"), build("on")];
