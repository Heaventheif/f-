"use strict";
export function checkAndSetCooldown(senderID, commandName, command) {
  const cdMsg = global.checkCooldown(senderID, commandName);
  if (cdMsg) return cdMsg;
  global.setCooldown(senderID, commandName, command.config?.countDown ?? 3);
  return null;
}

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-middlewares-cooldown',
  meta: { category: 'middleware', path: 'src/middlewares/cooldown.js' },
  setup(_ctx) {
    // provides: checkAndSetCooldown
  },
};
