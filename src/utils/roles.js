"use strict";
function buildRoleSets() {
  global._rolesets = {
    dev: new Set(
      [
        ...(global.config?.developers || []),
        ...(global.config?.admins || []),
        ...(global.config?.moderators || []),
      ].map(String),
    ),
  };
}
function getUserRole(uid, botIndex) {
  uid = String(uid);
  const r = global._rolesets || { dev: new Set() };
  if (r.dev.has(uid)) return 2;
  const adminMap = global._botAdminIds;
  if (adminMap && botIndex != null) {
    const adminId = adminMap.get(Number(botIndex));
    if (adminId && String(adminId) === uid) return 2;
  }
  return 0;
}
const COOLDOWN_SWEEP_AT = 5000;
const cooldowns = () => (global.userCooldowns ??= new Map());
function sweepCooldowns(now = Date.now()) {
  const m = cooldowns();
  let n = 0;
  for (const [k, exp] of m) {
    if (now >= exp) {
      m.delete(k);
      n++;
    }
  }
  return n;
}
function setCooldown(u, c, t) {
  const m = cooldowns();
  if (m.size >= COOLDOWN_SWEEP_AT) sweepCooldowns();
  m.set(`${u}:${c}`, Date.now() + t * 1e3);
}
function checkCooldown(u, c) {
  const m = cooldowns();
  const key = `${u}:${c}`;
  const exp = m.get(key);
  if (!exp || Date.now() >= exp) {
    m.delete(key);
    return null;
  }
  return `⏳ انتظر ${Math.ceil((exp - Date.now()) / 1e3)} ث`;
}
global.getUserRole = getUserRole;
global.setCooldown = setCooldown;
global.checkCooldown = checkCooldown;
global.sweepCooldowns = sweepCooldowns;
export { buildRoleSets, getUserRole, setCooldown, checkCooldown, sweepCooldowns };
