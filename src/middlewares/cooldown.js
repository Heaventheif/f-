"use strict";
export function checkAndSetCooldown(senderID, commandName, command) {
  const cdMsg = global.checkCooldown(senderID, commandName);
  if (cdMsg) return cdMsg;
  global.setCooldown(senderID, commandName, command.config?.countDown ?? 3);
  return null;
}
