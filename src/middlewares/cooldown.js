"use strict";
// Cooldown is split in two so it is only consumed when a command really runs:
// getCooldownMessage() is a pure check, consumeCooldown() starts the window.
export function getCooldownMessage(senderID, commandName) {
  return global.checkCooldown?.(senderID, commandName) ?? null;
}
export function consumeCooldown(senderID, commandName, command) {
  const secs = Number(command?.config?.countDown ?? 3);
  global.setCooldown?.(senderID, commandName, Number.isFinite(secs) && secs >= 0 ? secs : 3);
}
// Legacy combined helper (check, then consume when allowed).
export function checkAndSetCooldown(senderID, commandName, command) {
  const msg = getCooldownMessage(senderID, commandName);
  if (msg) return msg;
  consumeCooldown(senderID, commandName, command);
  return null;
}
