"use strict";

var fs   = require("fs");
var path = require("path");
var logger = require("../../utils/logger");

var SAVE_INTERVAL_MS  = 5 * 60 * 1000;
var DEBOUNCE_MS       = 30 * 1000;
var MIN_COOKIES       = 5;
var REQUIRED_COOKIE_KEYS = ["c_user", "xs"];

function isValidAppState(state) {
    if (!state || !Array.isArray(state) || state.length < MIN_COOKIES) return false;
    var keys = {};
    for (var i = 0; i < state.length; i++) {
        var c = state[i];
        if (!c || typeof c !== "object") return false;
        var key = c.key || c.name;
        if (!key || typeof c.value !== "string" || !c.value) return false;
        keys[key] = c.value;
    }
    for (var j = 0; j < REQUIRED_COOKIE_KEYS.length; j++) {
        if (!keys[REQUIRED_COOKIE_KEYS[j]]) return false;
    }
    return true;
}

module.exports = function (defaultFuncs, api, ctx) {

    if (ctx._sessionGuardAttached) {
        logger.warn("SessionGuard", "Already active for this session — ignoring duplicate init.");
        return function alreadyActive() {
            return {
                save: api.saveSession,
                stop: api.stopSessionGuard,
                restore: api.restoreSessionBackup
            };
        };
    }
    ctx._sessionGuardAttached = true;

    function getState() {
        try { return api.getAppState(); } catch (_) { return null; }
    }

    var writeLocks = Object.create(null);

    function withWriteLock(filePath, fn) {
        var prev = writeLocks[filePath] || Promise.resolve();
        var next = prev.catch(function () {}).then(fn);
        writeLocks[filePath] = next.catch(function () {});
        return next;
    }

    function atomicWriteFileSync(filePath, data) {

        var dir = path.dirname(filePath);
        var tmpPath = path.join(dir, "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp");
        fs.writeFileSync(tmpPath, data, "utf8");
        fs.renameSync(tmpPath, filePath);
    }

    function saveToDiskSync(filePath) {
        var state = getState();
        if (!isValidAppState(state)) {
            logger.warn("SessionGuard", "Skipped save — state looks empty, invalid, or missing required cookies (" + (state ? state.length : 0) + " cookies).");
            return false;
        }

        if (fs.existsSync(filePath)) {
            try {
                var existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (Array.isArray(existing) && state.length < existing.length * 0.8) {
                    logger.warn("SessionGuard", "Skipped save — new state has " + state.length + " cookies vs " + existing.length + " on disk (possible truncation).");
                    return false;
                }

                atomicWriteFileSync(filePath + ".bak", JSON.stringify(existing, null, 2));
            } catch (_) {}
        }

        atomicWriteFileSync(filePath, JSON.stringify(state, null, 2));
        logger.success("SessionGuard", "Session saved -> " + filePath + " (" + state.length + " cookies)");
        return true;
    }

    function saveToDisk(filePath) {

        var result;
        return withWriteLock(filePath, function () {
            try {
                result = saveToDiskSync(filePath);
            } catch (e) {
                logger.error("SessionGuard", "Save failed: " + (e && e.message ? e.message : String(e)));
                result = false;
            }
            return result;
        }).then(function () { return result; });
    }

    return function sessionGuard(appStatePath, options) {
        options = options || {};
        var interval    = options.interval !== undefined ? options.interval : SAVE_INTERVAL_MS;
        var debounce    = options.debounce !== undefined ? options.debounce : DEBOUNCE_MS;

        appStatePath = appStatePath || path.join(process.cwd(), "appstate.json");

        var lastSave     = 0;
        var intervalRef  = null;

        if (interval > 0) {
            intervalRef = setInterval(function () {
                logger.info("SessionGuard", "Periodic save...");
                saveToDisk(appStatePath);
                lastSave = Date.now();
            }, interval);
            if (intervalRef.unref) intervalRef.unref();
        }

        var originalSendMessage = api.sendMessage;
        api.sendMessage = function () {
            var result = originalSendMessage.apply(this, arguments);

            Promise.resolve(result).then(function () {
                if (Date.now() - lastSave > debounce) {
                    saveToDisk(appStatePath);
                    lastSave = Date.now();
                }
            }).catch(function () {});
            return result;
        };

        api.saveSession = function (customPath) {
            return saveToDisk(customPath || appStatePath);
        };

        api.restoreSessionBackup = function (customPath) {
            var bakPath = (customPath || appStatePath) + ".bak";
            if (!fs.existsSync(bakPath)) {
                logger.warn("SessionGuard", "No backup file found at " + bakPath);
                return false;
            }
            try {
                var bak = fs.readFileSync(bakPath, "utf8");
                atomicWriteFileSync(customPath || appStatePath, bak);
                logger.success("SessionGuard", "Backup restored from " + bakPath);
                return true;
            } catch (e) {
                logger.error("SessionGuard", "Restore failed: " + e.message);
                return false;
            }
        };

        api.stopSessionGuard = function () {
            if (intervalRef) clearInterval(intervalRef);
            api.sendMessage = originalSendMessage;
            ctx._sessionGuardAttached = false;
            logger.info("SessionGuard", "Stopped.");
        };

        logger.success(
            "SessionGuard",
            "Active — auto-save every " + Math.round(interval / 60000) + " min -> " + appStatePath
        );

        return {
            save:    function (p) { return saveToDisk(p || appStatePath); },
            stop:    api.stopSessionGuard,
            restore: api.restoreSessionBackup
        };
    };
};