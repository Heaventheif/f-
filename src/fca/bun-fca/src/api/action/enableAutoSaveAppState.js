"use strict";
const fs = require("fs");
const path = require("path");
const logger = require("../../../func/logger");

module.exports = function (defaultFuncs, api, ctx) {
  return function enableAutoSaveAppState(options = {}) {
    const filePath = options.filePath || path.join(process.cwd(), "appstate.json");
    const interval = options.interval || 5 * 60 * 1000;
    const saveOnLogin = options.saveOnLogin !== false;

    function saveAppState() {
      try {
        const appState = api.getAppState();
        if (!appState || !appState.appState || appState.appState.length === 0) {
          logger("AppState is empty, skipping save", "warn");
          return;
        }

        const data = JSON.stringify(appState, null, 2);
        fs.writeFileSync(filePath, data, "utf8");
        logger(`AppState saved to ${filePath}`, "info");
      } catch (error) {
        logger(`Error saving AppState: ${error && error.message ? error.message : String(error)}`, "error");
      }
    }

    let immediateSaveTimer = null;
    if (saveOnLogin) {

      immediateSaveTimer = setTimeout(() => {
        saveAppState();
        immediateSaveTimer = null;
      }, 2000);
    }

    const intervalId = setInterval(saveAppState, interval);
    logger(`Auto-save AppState enabled: ${filePath} (every ${Math.round(interval / 1000 / 60)} minutes)`, "info");

    if (!ctx._autoSaveInterval) {
      ctx._autoSaveInterval = [];
    }
    ctx._autoSaveInterval.push(intervalId);

    return function disableAutoSaveAppState() {

      if (immediateSaveTimer) {
        clearTimeout(immediateSaveTimer);
        immediateSaveTimer = null;
      }

      clearInterval(intervalId);
      const index = ctx._autoSaveInterval ? ctx._autoSaveInterval.indexOf(intervalId) : -1;
      if (index !== -1) {
        ctx._autoSaveInterval.splice(index, 1);
      }
      logger("Auto-save AppState disabled", "info");
    };
  };
};