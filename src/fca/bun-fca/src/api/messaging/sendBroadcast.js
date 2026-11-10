"use strict";

var logger = require("../../utils/logger");

module.exports = function (defaultFuncs, api, ctx) {
    return function sendBroadcast(msg, threadIDs, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        options = options || {};

        var delay     = typeof options.delay    === "number" ? options.delay    : 1000;
        var parallel  = typeof options.parallel === "number" ? options.parallel : 3;
        var onEach    = typeof options.onEach   === "function" ? options.onEach : null;

        if (!Array.isArray(threadIDs) || threadIDs.length === 0) {
            var err = new Error("sendBroadcast: threadIDs must be a non-empty array.");
            if (typeof callback === "function") return callback(err);
            return Promise.reject(err);
        }

        var sent   = [];
        var failed = [];
        var ids    = threadIDs.slice();

        logger.info("Broadcast", "Sending to " + ids.length + " threads [parallel=" + parallel + " delay=" + delay + "ms]");

        function sleep(ms) {
            return new Promise(function (res) { setTimeout(res, ms); });
        }

        async function sendOne(id) {
            try {
                var info = await api.sendMessage(msg, String(id));
                sent.push(String(id));
                if (onEach) onEach(null, info, id);
                logger.success("Broadcast", "-> " + id + " [" + sent.length + "/" + ids.length + "]");
            } catch (e) {
                failed.push({ id: String(id), error: e.message || String(e) });
                if (onEach) onEach(e, null, id);
                logger.warn("Broadcast", " " + id + ": " + (e.message || e));
            }
        }

        var promise = (async function () {
            var i = 0;
            while (i < ids.length) {
                var batch = ids.slice(i, i + parallel);
                var tasks = batch.map(function (id, idx) {
                    return sleep(idx * delay).then(function () { return sendOne(id); });
                });
                await Promise.all(tasks);
                i += parallel;
                if (i < ids.length) await sleep(delay);
            }

            var result = {
                sent:   sent,
                failed: failed,
                total:  ids.length
            };

            logger.success(
                "Broadcast",
                "Done — " + sent.length + " sent, " + failed.length + " failed out of " + ids.length
            );

            return result;
        })();

        if (typeof callback === "function") {
            promise.then(function (r) { callback(null, r); }).catch(function (e) { callback(e); });
        }

        return promise;
    };
};