"use strict";
export function checkAuth(senderID, command, botIndex = null, isGroupAdmin = false) {
  const role    = global.getUserRole(senderID, botIndex); // 0=عضو، 2=مطوّر (من config أو لوحة التحكم)
  const reqRole = command.config?.role ?? 0;
  // مشرف المجموعة (أدمن الشات في فيسبوك) يُعامَل كـ role 1 داخل مجموعته فقط
  // لا يرفع درجة المطوّر (2) ولا يمنح صلاحيات خارج المجموعة
  const effectiveRole = (isGroupAdmin && role < 1) ? 1 : role;
  return effectiveRole < reqRole;
}

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-middlewares-auth',
  meta: { category: 'middleware', path: 'src/middlewares/auth.js' },
  setup(_ctx) {
    // provides: checkAuth
  },
};
