"use strict";

module.exports = function createEmitAuth({ logger }) {
  return function emitAuth(ctx, api, globalCallback, reason, detail) {

    try {
      if (ctx._autoCycleTimer) {
        clearInterval(ctx._autoCycleTimer);
        ctx._autoCycleTimer = null;
      }
    } catch (_) { }
    try {
      if (ctx._reconnectTimer) {
        clearTimeout(ctx._reconnectTimer);
        ctx._reconnectTimer = null;
      }
    } catch (_) { }

    try {
      ctx._ending = true;
      ctx._cycling = false;
    } catch (_) { }

    try {
      if (ctx.mqttClient) {
        ctx.mqttClient.removeAllListeners();
        if (ctx.mqttClient.connected) {
          ctx.mqttClient.end(true);
        }
      }
    } catch (_) { }

    ctx.mqttClient = undefined;
    ctx.loggedIn = false;

    try {
      if (ctx._rTimeout) {
        clearTimeout(ctx._rTimeout);
        ctx._rTimeout = null;
      }
    } catch (_) { }

    try {
      if (ctx.tasks && ctx.tasks instanceof Map) {
        ctx.tasks.clear();
      }
    } catch (_) { }

    try {
      if (ctx._userInfoIntervals && Array.isArray(ctx._userInfoIntervals)) {
        ctx._userInfoIntervals.forEach(interval => {
          try {
            clearInterval(interval);
          } catch (_) { }
        });
        ctx._userInfoIntervals = [];
      }
    } catch (_) { }

    try {
      if (ctx._autoSaveInterval && Array.isArray(ctx._autoSaveInterval)) {
        ctx._autoSaveInterval.forEach(interval => {
          try {
            clearInterval(interval);
          } catch (_) { }
        });
        ctx._autoSaveInterval = [];
      }
    } catch (_) { }

    try {
      if (ctx._scheduler && typeof ctx._scheduler.destroy === "function") {
        ctx._scheduler.destroy();
        ctx._scheduler = undefined;
      }
    } catch (_) { }

    const msg = detail || reason;
    logger(`auth change -> ${reason}: ${msg}`, "error");

    if (typeof globalCallback === "function") {
      try {
        globalCallback({
          type: "account_inactive",
          reason,
          error: msg,
          timestamp: Date.now()
        }, null);
      } catch (cbErr) {
        logger(`emitAuth callback error: ${cbErr && cbErr.message ? cbErr.message : String(cbErr)}`, "error");
      }
    }
  };
};