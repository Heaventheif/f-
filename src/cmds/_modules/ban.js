"use strict";
import { resolveTargets, protectedIds, botId } from "../../admin/targets.js";
import { setBan } from "../../utils/banStore.js";
import { getStore } from "../../state/kv.js";
const config = {
  name: "ban",
  aliases: ["حظر"],
  version: "1.0.0",
  countDown: 3,
  role: 2,
  groupOnly: true,
  description: { ar: "إدارة حظر المجموعات والأفراد" },
  category: "admin",
  guide: {
    ar: "{pn} list [صفحة]           — عرض قوائم الحظر\n{pn} group [GID]           — حظر المجموعة الحالية أو GID\n{pn} user @شخص [سبب]       — حظر فرد بالمنشن/الرد/UID مع سبب اختياري\n{pn} ungroup [GID]         — إزالة حظر مجموعة\n{pn} unuser @شخص           — إزالة حظر فرد",
  },
};
const PAGE_SIZE = 10;
const ID_RE = /^\d{6,}$/;

// Pure: splits ids into bannable / refused (owner, admins, bot, self).
export function planBan(
  ids,
  { botID = "", protectedSet = new Set(), senderID = "" },
) {
  const allowed = [];
  const refused = [];
  for (const id of ids) {
    if (id === botID) refused.push({ id, why: "البوت" });
    else if (protectedSet.has(id)) refused.push({ id, why: "مطوّر/مشرف محمي" });
    else if (id === String(senderID)) refused.push({ id, why: "نفسك" });
    else allowed.push(id);
  }
  return { allowed, refused };
}

// Pure: one page of ban rows. rows: [{id, reason?, at?}]; page is 1-based and clamped.
export function paginateBans(rows, page = 1, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return {
    page: p,
    pages,
    total: rows.length,
    items: rows.slice((p - 1) * size, p * size),
  };
}

const metaNs = async () => (await getStore()).ns("ban_meta");
async function getMeta() {
  try {
    const ns = await metaNs();
    return new Map(await ns.list());
  } catch {
    return new Map();
  }
}
async function setMeta(key, value) {
  try {
    const ns = await metaNs();
    if (value) await ns.set(key, value);
    else await ns.del(key);
  } catch (e) {
    console.warn("[BAN] meta not saved:", e?.message || e);
  }
}
const fmtAt = (at) => (at ? String(at).slice(0, 16).replace("T", " ") : "");

function send(api, event, text) {
  if (typeof global.safeSend === "function")
    return global.safeSend(api, text, event.threadID, null, event.messageID);
  return api.sendMessage(text, event.threadID, null, event.messageID);
}

async function banGroup(api, event, args, remove) {
  const targetID = String(args[0] || event.threadID).trim();
  if (!ID_RE.test(targetID))
    return send(api, event, "⚠️ أدخل GID صحيحاً (أرقام فقط).");
  const already = global._bannedGroups?.has(targetID);
  if (remove ? !already : already)
    return send(
      api,
      event,
      `${remove ? "ℹ️ المجموعة غير محظورة." : "⚠️ المجموعة محظورة بالفعل."}\nGID: ${targetID}`,
    );
  const reason = remove ? "" : args.slice(1).join(" ").trim().slice(0, 200);
  await setBan("group", targetID, !remove, event.senderID);
  await setMeta(
    `group:${targetID}`,
    remove ? null : { reason, at: new Date().toISOString() },
  );
  return send(
    api,
    event,
    `${remove ? "✅ تمت إزالة حظر المجموعة." : "🚫 تم حظر المجموعة."}\nGID: ${targetID}`,
  );
}

async function banUsers(api, event, args, remove = false) {
  const t = resolveTargets(event, args);
  if (!t.ids.length)
    return send(
      api,
      event,
      "⚠️ قم بمنشن الشخص أو الرد على رسالته أو أدخل UID صحيحاً.",
    );
  const reason = remove ? "" : t.text.slice(0, 200);
  const results = [];
  let ids = t.ids;
  if (!remove) {
    const plan = planBan(ids, {
      botID: botId(api),
      protectedSet: protectedIds(api),
      senderID: event.senderID,
    });
    for (const r of plan.refused)
      results.push(`⛔ لا يمكن حظر ${r.id} (${r.why}).`);
    ids = plan.allowed;
  }
  for (const uid of ids) {
    try {
      const already = global._bannedUsers?.has(uid);
      if (remove ? !already : already) {
        results.push(
          remove ? `ℹ️ ${uid} غير محظور.` : `⚠️ ${uid} محظور بالفعل.`,
        );
        continue;
      }
      await setBan("user", uid, !remove, event.senderID);
      await setMeta(
        `user:${uid}`,
        remove ? null : { reason, at: new Date().toISOString() },
      );
      results.push(
        remove
          ? `✅ أزيل حظر ${uid}.`
          : `🚫 تم حظر ${uid}${reason ? ` — ${reason}` : ""}.`,
      );
    } catch (err) {
      console.warn(
        `[BAN:${remove ? "UNUSER" : "USER"}] ${uid}`,
        err?.message || err,
      );
      results.push(`❌ فشل تحديث حظر ${uid}.`);
    }
  }
  return send(api, event, results.join("\n"));
}

async function listBans(api, event, pageArg) {
  const meta = await getMeta();
  const row = (kind) => (id) => {
    const m = meta.get(`${kind}:${id}`) || {};
    const extra = [m.reason, fmtAt(m.at)].filter(Boolean).join(" | ");
    return { id, text: extra ? `${id} (${extra})` : id };
  };
  const groups = [...(global._bannedGroups || [])]
    .map(String)
    .sort()
    .map(row("group"));
  const users = [...(global._bannedUsers || [])]
    .map(String)
    .sort()
    .map(row("user"));
  const all = [
    ...groups.map((r) => ({ ...r, k: "g" })),
    ...users.map((r) => ({ ...r, k: "u" })),
  ];
  const pg = paginateBans(all, pageArg);
  const line = (r) => `${r.k === "g" ? "👥" : "👤"} ${r.text}`;
  const body = pg.items.length ? pg.items.map(line).join("\n") : "لا يوجد";
  return send(
    api,
    event,
    `🚫 قائمة الحظر\nمجموعات: ${groups.length} | أفراد: ${users.length}\n\n${body}\n\nصفحة ${pg.page}/${pg.pages}${pg.pages > 1 ? " — ban list <رقم>" : ""}`,
  );
}

export default {
  config,
  async onStart({ api, event, args, prefix }) {
    const action = String(args[0] || "list").toLowerCase();
    try {
      if (["list", "show", "عرض", "قائمة"].includes(action))
        return await listBans(api, event, args[1]);
      if (["group", "المجموعة", "جروب"].includes(action))
        return await banGroup(api, event, args.slice(1), false);
      if (["ungroup", "unblock-group", "unban-group"].includes(action))
        return await banGroup(api, event, args.slice(1), true);
      if (["user", "person", "فرد", "شخص"].includes(action))
        return await banUsers(api, event, args.slice(1));
      if (["unuser", "unblock-user", "unban-user"].includes(action))
        return await banUsers(api, event, args.slice(1), true);
      return send(
        api,
        event,
        `❓ الاستخدام:\n${config.guide.ar.replace(/{pn}/g, prefix + "ban")}`,
      );
    } catch (err) {
      console.error("[BAN]", err?.message || err);
      return send(api, event, "❌ تعذّرت عملية الحظر؛ راجع السجل وحاول مجدداً.");
    }
  },
};
