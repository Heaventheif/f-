"use strict";
// Authorization gate. Returns true when the sender may run the command,
// otherwise a short machine-readable reason string (truthy, never `true`).
export function isAuthorized(senderID, command, botIndex = null, isGroupAdmin = false) {
  const role = global.getUserRole?.(senderID, botIndex) ?? 0;
  const reqRole = Number(command?.config?.role ?? 0) || 0;
  const effectiveRole = isGroupAdmin && role < 1 ? 1 : role;
  return effectiveRole >= reqRole ? true : `role:${reqRole}`;
}
