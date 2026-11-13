"use strict";
import { setBotOff, setCommandOff, commandKey } from "../utils/offState.js";
const CONTROL = new Set(["off", "on"]);
const NOT_SAVED = "⚠️ طُبّق التغيير مؤقتاً فقط ولم يُحفظ؛ سيُفقد عند إعادة تشغيل البوت.\n";
// Commands that must stay reachable: the on/off pair and anything restricted to bot admins.
export function isProtected(command, key) {
  return CONTROL.has(key) || Number(command?.config?.role ?? 0) >= 2;
}
function build(action) {
  const off = action === "off";
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
      guide: {
        ar: `{pn}${action} <أمر>
{pn}${action} bot`,
      },
    },
    async onStart({ event, args, role, message, prefix }) {
      const reply = (t) => message.reply(t);
      const threadID = event?.threadID;
      if (!event?.isGroup || !threadID) return reply("⚠️ هذا الأمر يعمل داخل المجموعات فقط.");
      if ((role ?? 0) < 2) return reply("⛔ ليس لديك صلاحية تنفيذ هذا الإجراء.");
      const usage = `❓ الاستخدام:
${prefix || ""}${action} <أمر>
${prefix || ""}${action} bot
${prefix || ""}${action} cmd <أمر>   (للأمر الذي اسمه bot)`;
      let list = args.map((a) => String(a).trim()).filter(Boolean);
      // `off cmd bot` addresses a real command named "bot" instead of the bot-wide switch.
      const explicitCmd = list[0]?.toLowerCase() === "cmd";
      if (explicitCmd) list = list.slice(1);
      if (list.length !== 1) return reply(usage);
      const target = list[0].toLowerCase();
      if (target === "bot" && !explicitCmd) {
        const { changed: changed2, persisted: persisted2 } = await setBotOff(threadID, off);
        if (!changed2) {
          return reply(
            off
              ? "ℹ️ البوت موقوف بالفعل في هذه المجموعة."
              : "ℹ️ البوت يعمل بالفعل في هذه المجموعة.",
          );
        }
        return reply(
          (persisted2 ? "" : NOT_SAVED) +
            (off
              ? "🔕 تم إيقاف البوت في هذه المجموعة.\nللاستعادة: on bot"
              : "🔔 تمت إعادة تشغيل البوت في هذه المجموعة."),
        );
      }
      const command = global.commands?.get(target);
      const key = commandKey(command);
      if (!command || !key) return reply(`❓ الأمر «${target}» غير موجود.`);
      if (isProtected(command, key))
        return reply(`⚠️ لا يمكن ${off ? "تعطيل" : "تفعيل"} أوامر التحكم أو أوامر المشرفين (${key}).`);
      const { changed, persisted } = await setCommandOff(threadID, key, off);
      if (!changed) {
        return reply(
          off
            ? `ℹ️ الأمر «${key}» معطّل مسبقًا في هذه المجموعة.`
            : `ℹ️ الأمر «${key}» مفعّل بالفعل في هذه المجموعة.`,
        );
      }
      return reply(
        (persisted ? "" : NOT_SAVED) +
          (off ? `🚫 تم تعطيل الأمر «${key}» في هذه المجموعة.` : `✅ تم تفعيل الأمر «${key}» في هذه المجموعة.`),
      );
    },
  };
}
export const commands = [build("off"), build("on")];
