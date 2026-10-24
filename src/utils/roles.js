"use strict";
// ─── نظام صلاحيات مبسّط بـ 3 درجات فقط ───────────────────────────
// 2 = المطوّر  (developers في config.json، أو صاحب الحساب من لوحة التحكم)
// 1 = مشرف المجموعة (أدمن الشات في فيسبوك — يُحسب تلقائياً لكل ثريد، وليس من هنا)
// 0 = عضو عادي
function buildRoleSets() {
  global._rolesets = {
    dev: new Set((global.config.developers || []).map(String)),
  };
}
function getUserRole(uid, botIndex) {
  uid = String(uid);
  const r = global._rolesets || { dev: new Set() };
  // المطوّر عبر config.json
  if (r.dev.has(uid)) return 2;
  // المطوّر عبر لوحة التحكم: صاحب هذا الحساب (adminId) = مطوّر لهذا البوت بالذات
  // هذا يحل مشكلة تنزيل صاحب اللوحة إلى درجة أقل من المطلوبة للأوامر الحساسة
  const adminMap = global._botAdminIds;
  if (adminMap && botIndex != null) {
    const adminId = adminMap.get(Number(botIndex));
    if (adminId && String(adminId) === uid) return 2;
  }
  return 0;
}
function setCooldown(u, c, t) {
  global.userCooldowns.set(`${u}:${c}`, Date.now() + t * 1000);
}
function checkCooldown(u, c) {
  const key = `${u}:${c}`;
  const exp = global.userCooldowns.get(key);
  if (!exp || Date.now() >= exp) {
    global.userCooldowns.delete(key);
    return null;
  }
  return `⏳ انتظر ${Math.ceil((exp - Date.now()) / 1000)} ث`;
}
global.getUserRole = getUserRole;
global.setCooldown = setCooldown;
global.checkCooldown = checkCooldown;
export { buildRoleSets, getUserRole, setCooldown, checkCooldown };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-roles',
  meta: { category: 'utils', path: 'src/utils/roles.js' },
  setup(_ctx) {
    // provides: buildRoleSets, checkCooldown, getUserRole, setCooldown
  },
};
