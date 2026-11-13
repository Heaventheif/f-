"use strict";
import { resolveTargets, displayNames, protectedIds, botId, planKick, REFUSE_TEXT, sleep } from "../../admin/targets.js";

const say = (api, event, text) => global.safeSend(api, text, event.threadID, null, event.messageID);
const MAX_TARGETS = 10;
const GAP_MS = 800;
const _config = {
  name: "user",
  version: "2.2.0",
  author: "dev",
  countDown: 5,
  role: 1,
  description: { ar: "إدارة المستخدمين: معرف، اسم، طرد، إضافة" },
  category: "admin",
  guide: {
    ar: "{pn} id @شخص          — عرض UID الشخص\n{pn} name @شخص <اسم>  — تغيير اللقب\n{pn} kick @شخص        — طرد من المجموعة\n{pn} add <UID>         — إضافة مستخدم للمجموعة",
  },
};
export default {
  config: _config,
  onStart: async function ({ api, event, args, role, Users, Threads, prefix }) {
    const sub = (args[0] || "").toLowerCase();
    switch (sub) {
      case "id":
        return handleID(api, event, args.slice(1));
      case "name":
        return handleName(api, event, args.slice(1));
      case "kick":
        return handleKick(api, event, args.slice(1));
      case "add":
        return handleAdd(api, event, args.slice(1));
      default:
        return say(api, event, `❓ الاستخدام:\n${_config.guide.ar.replace(/{pn}/g, prefix + "user")}`);
    }
  },
};
// Runs `op` for each id with a delay between calls; collects one result line per id.
async function massOp(api, event, ids, names, op, okText, failText) {
  const nameOf = await displayNames(api, ids, names);
  const lines = [];
  for (let i = 0; i < ids.length; i++) {
    if (i) await sleep(GAP_MS);
    try {
      await op(ids[i]);
      lines.push(`✅ ${okText(nameOf(ids[i]))} — ${ids[i]}`);
    } catch (e) {
      console.error("[USER]", ids[i], e?.error ?? e?.message ?? e);
      lines.push(`❌ ${failText(ids[i], e)}`);
    }
  }
  return lines;
}
function tooMany(api, event, ids) {
  if (ids.length <= MAX_TARGETS) return null;
  return say(api, event, `⚠️ الحد الأقصى ${MAX_TARGETS} أشخاص في الأمر الواحد.`);
}
async function handleID(api, event, args = []) {
  const { ids } = resolveTargets(event, args);
  return say(api, event, ids.length ? ids.join("\n") : String(event.senderID ?? ""));
}
async function handleName(api, event, args) {
  const { ids, names, text } = resolveTargets(event, args);
  if (!ids.length) return say(api, event, "⚠️ قم بمنشن الشخص المراد تغيير لقبه.");
  if (!text) return say(api, event, "⚠️ أدخل الاسم الجديد بعد المنشن.\nمثال: user name @شخص الاسم الجديد");
  if (text.length > 60) return say(api, event, "⚠️ اللقب طويل جداً (الحد 60 حرفاً).");
  const over = tooMany(api, event, ids);
  if (over) return over;
  const lines = await massOp(
    api, event, ids, names,
    (uid) => api.changeNickname(text, event.threadID, uid),
    (n) => `تم تغيير لقب ${n} إلى "${text}"`,
    (uid) => `فشل تغيير لقب ${uid}`,
  );
  return say(api, event, lines.join("\n"));
}
async function handleKick(api, event, args = []) {
  const { ids, names } = resolveTargets(event, args);
  if (!ids.length) return say(api, event, "⚠️ قم بمنشن الشخص المراد طرده.");
  const over = tooMany(api, event, ids);
  if (over) return over;
  let threadAdmins = [];
  try {
    const info = await api.getThreadInfo(event.threadID);
    threadAdmins = (info?.adminIDs || []).map((a) => String(a?.id ?? a));
  } catch (e) {
    console.error("[USER:kick] could not read thread admins:", e?.message);
    return say(api, event, "❌ تعذّر التحقق من مشرفي المجموعة؛ لم يُنفَّذ الطرد.");
  }
  const plan = planKick(ids, { botID: botId(api), protectedSet: protectedIds(api), threadAdmins, senderID: String(event.senderID ?? "") });
  const nameOf = await displayNames(api, ids, names);
  const lines = plan.refused.map((r) => `⛔ ${nameOf(r.id)} — ${REFUSE_TEXT[r.reason]}`);
  lines.push(
    ...(await massOp(
      api, event, plan.allowed, names,
      (uid) => api.removeUserFromGroup(uid, event.threadID),
      (n) => `تم طرد ${n}`,
      (uid) => `فشل طرد ${uid} — تحقق من صلاحيات البوت`,
    )),
  );
  return say(api, event, lines.join("\n"));
}
async function handleAdd(api, event, args) {
  const { ids, names } = resolveTargets(event, args);
  if (!ids.length)
    return say(api, event, "⚠️ قم بمنشن الشخص أو أدخل UID الشخص المراد إضافته.\nمثال: user add 100012345678");
  const over = tooMany(api, event, ids);
  if (over) return over;
  const lines = await massOp(
    api, event, ids, names,
    (uid) => api.addUserToGroup(uid, event.threadID),
    (n) => `تمت إضافة ${n}`,
    (uid, err) => {
      const reason = err?.error === 1545145 ? "الشخص موجود بالفعل" : err?.error === 200 ? "لا توجد صلاحية كافية" : "خطأ غير معروف";
      return `فشل إضافة ${uid}: ${reason}`;
    },
  );
  return say(api, event, lines.join("\n"));
}
