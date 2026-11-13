"use strict";
import { resolveTargets, displayNames, botId, sleep } from "../../admin/targets.js";

const say = (api, event, text) => global.safeSend(api, text, event.threadID, null, event.messageID);
const _config = {
  name: "group",
  version: "2.3.0",
  author: "dev",
  countDown: 5,
  role: 1,
  description: { ar: "إدارة المجموعة: معلومات، إحصائيات، تغيير الاسم، إدارة المشرفين" },
  category: "admin",
  guide: {
    ar: "{pn} info               — معلومات المجموعة (GID + الأعضاء)\n{pn} id                 — عرض GID فقط\n{pn} stats              — إحصائيات المجموعة\n{pn} rename <الاسم>     — تغيير اسم المجموعة\n{pn} admin add @شخص    — إضافة مشرف\n{pn} admin remove @شخص — إزالة مشرف",
  },
};
export default {
  config: _config,
  onStart: async function ({ api, event, args, role, Threads, Users, prefix }) {
    const { threadID } = event;
    const sub = (args[0] || "").toLowerCase();
    switch (sub) {
      case "info":
        return handleInfo(api, event);
      case "id":
        return say(api, event, String(threadID));
      case "stats":
        return handleStats(api, event);
      case "rename":
        return handleRename(api, event, args.slice(1).join(" "));
      case "admin":
        return handleAdmin(api, event, args.slice(1));
      default:
        return say(api, event, `❓ الاستخدام:\n${_config.guide.ar.replace(/{pn}/g, prefix + "group")}`);
    }
  },
};
async function handleInfo(api, event) {
  const { threadID } = event;
  let info;
  try {
    info = await api.getThreadInfo(threadID);
  } catch (e) {
    console.error("[GROUP:info]", e?.message || e);
    return say(api, event, "❌ فشل جلب معلومات المجموعة.");
  }
  const ids = Array.isArray(info.participantIDs) ? info.participantIDs.map(String) : [];
  const shown = ids.slice(0, 30);
  const nameOf = await displayNames(api, shown);
  const memberList = shown.map((id, i) => `  ${i + 1}. ${nameOf(id)} — ${id}`).join("\n");
  return say(
    api,
    event,
    `📋 ─── معلومات المجموعة ───\n🆔 GID : ${threadID}\n📝 الاسم : ${info.threadName || "—"}\n👥 الأعضاء : ${ids.length}\n🛡️ المشرفون : ${info.adminIDs?.length ?? 0}\n\n👤 قائمة الأعضاء (أول 30):\n${memberList}` +
      (ids.length > 30 ? `\n  … و ${ids.length - 30} آخرين` : ""),
  );
}
async function handleStats(api, event) {
  const { threadID } = event;
  let info;
  try {
    info = await api.getThreadInfo(threadID);
  } catch (e) {
    console.error("[GROUP:stats]", e?.message || e);
    return say(api, event, "❌ فشل جلب إحصائيات المجموعة.");
  }
  const count = Array.isArray(info.participantIDs) ? info.participantIDs.length : 0;
  const ts = Number(info.timestamp);
  const last = Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleString("ar-EG", { timeZone: process.env.TZ || "UTC" }) : "—";
  return say(
    api,
    event,
    `📊 ─── إحصائيات المجموعة ───\n🆔 GID       : ${threadID}\n📝 الاسم     : ${info.threadName || "—"}\n👥 الأعضاء   : ${count}\n💬 الرسائل   : ${info.messageCount ?? "—"}\n🔒 موافقة    : ${info.approvalMode ? "مفعّل ✅" : "معطّل ❌"}\n📅 آخر نشاط  : ${last}`,
  );
}
async function handleRename(api, event, newName) {
  const name = newName.trim();
  if (!name) return say(api, event, "⚠️ أدخل الاسم الجديد للمجموعة.");
  if (name.length > 100) return say(api, event, "⚠️ الاسم طويل جداً (الحد 100 حرف).");
  try {
    await api.setTitle(name, event.threadID);
    return say(api, event, `✅ تم تغيير اسم المجموعة إلى:\n"${name}"`);
  } catch (e) {
    console.error("[GROUP:rename]", e?.message || e);
    return say(api, event, "❌ فشل تغيير اسم المجموعة.");
  }
}
async function isAdminNow(api, threadID, uid) {
  try {
    const info = await api.getThreadInfo(threadID);
    return (info?.adminIDs || []).some((a) => String(a?.id ?? a) === uid);
  } catch {
    return null;
  }
}
async function handleAdmin(api, event, args) {
  const { threadID } = event;
  const action = (args[0] || "").toLowerCase();
  if (!["add", "remove"].includes(action))
    return say(api, event, "⚠️ الاستخدام:\ngroup admin add @شخص\ngroup admin remove @شخص");
  const { ids, names } = resolveTargets(event, args.slice(1));
  if (!ids.length) return say(api, event, "⚠️ قم بمنشن الشخص أو رد على رسالته أو أدخل UID الشخص.");
  const me = botId(api);
  const nameOf = await displayNames(api, ids, names);
  const want = action === "add";
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const uid = ids[i];
    if (i) await sleep(700);
    if (!want && uid === me) {
      results.push("⚠️ لا يمكن إزالة إشراف البوت.");
      continue;
    }
    let failure = null;
    try {
      await api.changeAdminStatus(threadID, uid, want);
    } catch (e) {
      failure = e;
    }
    if (failure) {
      // The API sometimes errors although the change went through: verify before reporting failure.
      const now = await isAdminNow(api, threadID, uid);
      if (now === want) failure = null;
      else console.error("[GROUP:admin]", uid, failure?.error ?? failure?.message ?? failure);
    }
    results.push(
      failure
        ? `❌ فشل مع ${nameOf(uid)} — ${uid}`
        : `✅ ${want ? "تمت إضافة" : "تمت إزالة"} ${nameOf(uid)} — ${uid}`,
    );
  }
  return say(api, event, results.join("\n"));
}
