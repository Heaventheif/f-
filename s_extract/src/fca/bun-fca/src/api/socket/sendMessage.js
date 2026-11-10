"use strict";

var utils = require("../../utils/utils");
var logger = require("../../utils/logger");
var { getTextEffectId, getTextEffectIds } = require("../../utils/textEffects");
var { waitTurn } = require("../../utils/sendThrottle");

var ALLOWED = {
    attachment: true, url: true, sticker: true, emoji: true,
    emojiSize: true, body: true, mentions: true, location: true,
    replyToMessage: true, forwardAttachmentIds: true, text_effect_ids: true,
    textEffect: true, text_effect: true, text_effect_id: true,
    textEffectId: true, textEffectID: true, effect: true, effect_id: true,
    effectID: true, text_effect_name: true, effectName: true, effect_name: true
};

var EMOJI_SIZES = { small: 1, medium: 2, large: 3 };

function toEmojiSize(size) {
    if (typeof size === "number" && !isNaN(size)) return Math.min(3, Math.max(1, size));
    if (typeof size === "string" && size in EMOJI_SIZES) return EMOJI_SIZES[size];
    return 1;
}

function hasLinks(text) {
    return /(https?:\/\/|www\.|t\.me\/|fb\.me\/|youtu\.be\/|facebook\.com\/|youtube\.com\/)/i.test(text);
}

function buildMentionData(msg, baseBody) {
    if (!Array.isArray(msg.mentions) || !msg.mentions.length) return null;
    var ids = [], offsets = [], lengths = [], types = [];
    for (var i = 0; i < msg.mentions.length; i++) {
        var mention = msg.mentions[i];
        var tag = String(mention.tag || "");
        if (tag && !tag.startsWith("@")) tag = "@" + tag;
        var fromIndex = Number.isInteger(mention.fromIndex) ? mention.fromIndex : 0;
        var offset = baseBody.indexOf(tag, fromIndex);
        if (offset === -1) offset = baseBody.indexOf(tag.slice(1), fromIndex);
        if (offset < 0) offset = 0;
        ids.push(String(mention.id || 0));
        offsets.push(offset);
        lengths.push(tag.length);
        types.push("p");
    }
    return {
        mention_ids: ids.join(","),
        mention_offsets: offsets.join(","),
        mention_lengths: lengths.join(","),
        mention_types: types.join(",")
    };
}

function extractIdsFromPayload(payload) {
    var messageID = null, threadID = null;
    function walk(node) {
        if (!Array.isArray(node)) return;
        if (node[0] === 5 && (node[1] === "replaceOptimsiticMessage" || node[1] === "replaceOptimisticMessage")) {
            messageID = String(node[3]);
        }
        if (node[0] === 5 && node[1] === "writeCTAIdToThreadsTable") {
            var candidate = node[2];
            if (Array.isArray(candidate) && candidate[0] === 19) threadID = String(candidate[1]);
        }
        for (var i = 0; i < node.length; i++) walk(node[i]);
    }
    try { walk(payload && payload.step); } catch (_) { }
    return { threadID, messageID };
}

function publishLsRequestWithAck(mqttClient, content, requestId, timeout) {
    timeout = timeout || 18000;
    return new Promise(function (resolve, reject) {
        if (!mqttClient || typeof mqttClient.publish !== "function") {
            return reject(new Error("MQTT client not available"));
        }

        var settled = false;
        function done(err, val) {
            if (settled) return;
            settled = true;
            try { clearTimeout(timer); } catch (_) { }
            try { mqttClient.removeListener("message", onMessage); } catch (_) { }
            if (err) reject(err);
            else resolve(val);
        }

        var timer = setTimeout(function () {
            done(new Error("MQTT sendMessage timed out after " + timeout + "ms"));
        }, timeout);

        function onMessage(topic, message) {
            if (topic !== "/ls_resp") return;
            try {
                var data = JSON.parse(message.toString());
                if (String(data.request_id) !== String(requestId)) return;
                var extracted = extractIdsFromPayload(data.payload ? JSON.parse(data.payload) : {});
                done(null, {
                    threadID: extracted.threadID,
                    messageID: extracted.messageID
                });
            } catch (_) { }
        }

        mqttClient.on("message", onMessage);
        try {
            mqttClient.publish("/ls_req", JSON.stringify(content), { qos: 1 }, function (err) {
                if (err) done(err);
            });
        } catch (pubErr) {
            done(pubErr);
        }
    });
}

function waitForMqtt(ctx, maxMs) {
    maxMs = maxMs || 4000;
    return new Promise(function (resolve) {
        var client = ctx.mqttClient || global.mqttClient;
        if (client && client.connected) return resolve(client);
        var start = Date.now();
        var iv = setInterval(function () {
            var c = ctx.mqttClient || global.mqttClient;
            if (c && c.connected) {
                clearInterval(iv);
                return resolve(c);
            }
            if (Date.now() - start >= maxMs) {
                clearInterval(iv);
                return resolve(c || null);
            }
        }, 200);
    });
}

module.exports = function (defaultFuncs, api, ctx) {
    var uploadAttachmentFn = require("../messaging/uploadAttachment")(defaultFuncs, api, ctx);

    async function uploadAttachments(attachments) {
        if (!Array.isArray(attachments)) attachments = [attachments];
        return uploadAttachmentFn(attachments);
    }

    async function sendViaMqtt(msg, threadID, replyToMessage, ackTimeout) {
        var mqttClient = await waitForMqtt(ctx, 4000);
        if (!mqttClient || !mqttClient.connected) {
            throw new Error("MQTT client not available");
        }

        var baseBody = msg.body != null ? String(msg.body) : "";
        var requestId = Math.floor(100 + Math.random() * 900);

        var payload0 = {
            thread_id: String(threadID),
            otid: utils.generateOfflineThreadingID(),
            source: 2097153,
            send_type: 1,
            sync_group: 1,
            mark_thread_read: 1,
            text: baseBody === "" ? null : baseBody,
            initiating_source: 0,
            skip_url_preview_gen: 1,
            text_has_links: hasLinks(baseBody) ? 1 : 0,
            multitab_env: 0,
            metadata_dataclass: JSON.stringify({ media_accessibility_metadata: { alt_text: null } })
        };

        var mentionData = buildMentionData(msg, baseBody);
        if (mentionData) payload0.mention_data = mentionData;

        var textEffectId = getTextEffectId(msg);
        if (textEffectId) payload0.text_effect_id = textEffectId;
        var effectArray = getTextEffectIds(msg);
        if (effectArray.length) payload0.text_effect_ids = effectArray;

        if (msg.sticker) {
            payload0.send_type = 2;
            payload0.sticker_id = msg.sticker;
        }
        if (msg.emoji) {
            payload0.send_type = 1;
            payload0.text = msg.emoji;
            payload0.hot_emoji_size = toEmojiSize(msg.emojiSize);
        }

        if (msg.location && msg.location.latitude != null && msg.location.longitude != null) {
            payload0.send_type = 1;
            payload0.location_data = {
                coordinates: {
                    latitude: msg.location.latitude,
                    longitude: msg.location.longitude
                },
                is_current_location: Boolean(msg.location.current),
                is_live_location: Boolean(msg.location.live)
            };
        }

        var effectiveReplyTo = replyToMessage || msg.replyToMessage;
        if (effectiveReplyTo) {
            payload0.reply_metadata = {
                reply_source_id: effectiveReplyTo,
                reply_source_type: 1,
                reply_type: 0
            };
        }

        if (msg.attachment) {
            payload0.send_type = 3;
            if (payload0.text === "") payload0.text = null;
            payload0.attachment_fbids = [];
            var list = Array.isArray(msg.attachment) ? msg.attachment : [msg.attachment];
            var preuploaded = [], toUpload = [];
            for (var item of list) {
                if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "string") {
                    preuploaded.push(String(item[1]));
                } else if (utils.isReadableStream(item)) {
                    toUpload.push(item);
                }
            }
            if (preuploaded.length) payload0.attachment_fbids = payload0.attachment_fbids.concat(preuploaded);
            if (msg.forwardAttachmentIds && msg.forwardAttachmentIds.length) {
                payload0.attachment_fbids = payload0.attachment_fbids.concat(msg.forwardAttachmentIds.map(String));
            }
            if (toUpload.length) {
                var uploaded = await uploadAttachments(toUpload);
                for (var u of uploaded) {
                    if (!u) continue;
                    var fbid = u.image_id || u.video_id || u.audio_id || u.file_id || u.sticker_id || u.gif_id;
                    if (!fbid) {
                        var firstKey = Object.keys(u).find(function (k) {
                            return u[k] && /^\d+$/.test(String(u[k]));
                        });
                        if (firstKey) fbid = u[firstKey];
                    }
                    if (fbid) payload0.attachment_fbids.push(String(fbid));
                }
            }
            if (!payload0.attachment_fbids.length) delete payload0.attachment_fbids;
        }

        var tasks = [
            {
                label: "46",
                payload: JSON.stringify(payload0),
                queue_name: String(threadID),
                task_id: 400,
                failure_count: null
            },
            {
                label: "21",
                payload: JSON.stringify({
                    thread_id: String(threadID),
                    last_read_watermark_ts: Date.now(),
                    sync_group: 1
                }),
                queue_name: String(threadID),
                task_id: 401,
                failure_count: null
            }
        ];

        var content = {
            app_id: "2220391788200892",
            payload: JSON.stringify({
                tasks: tasks,
                epoch_id: (BigInt(Date.now()) << 22n).toString(),
                version_id: "24804310205905615"
            }),
            request_id: requestId,
            type: 3
        };

        var timeout = ackTimeout || 18000;
        try {
            return await publishLsRequestWithAck(mqttClient, content, requestId, timeout);
        } catch (firstErr) {
            var msgErr = firstErr && firstErr.message ? firstErr.message : String(firstErr);
            if (!/timed out/i.test(msgErr)) throw firstErr;
            logger.warn("sendMessage", "MQTT ack timeout - one soft retry");
            await new Promise(function (r) { setTimeout(r, 800 + Math.floor(Math.random() * 700)); });
            mqttClient = await waitForMqtt(ctx, 3000);
            if (!mqttClient || !mqttClient.connected) throw firstErr;

            requestId = Math.floor(100 + Math.random() * 900);
            content.request_id = requestId;
            return await publishLsRequestWithAck(mqttClient, content, requestId, Math.min(timeout + 5000, 25000));
        }
    }

    async function sendViaOldMessage(msg, threadID, replyToMessage, isSingleUser) {
        if (typeof api.OldMessage !== "function") {
            throw new Error("OldMessage fallback is not available");
        }
        return new Promise(function (res2, rej2) {
            api.OldMessage(msg, threadID, function (err2, data2) {
                if (err2) rej2(err2);
                else res2(data2);
            }, replyToMessage, isSingleUser);
        });
    }

    return async function sendMessage(msg, threadID, callback, replyToMessage, isSingleUser) {
        if (typeof msg === "string") msg = { body: msg };
        if (typeof callback !== "function") callback = null;

        var resolve, reject;
        var promise = new Promise(function (res, rej) {
            resolve = res;
            reject = rej;
        });

        for (var key in msg) {
            if (!ALLOWED[key]) {
                var err = new Error("Message key '" + key + "' is not allowed.");
                if (callback) callback(err);
                else reject(err);
                return promise;
            }
        }

        if (!threadID && threadID !== 0) {
            var tidErr = new Error("threadID is required");
            if (callback) callback(tidErr);
            else reject(tidErr);
            return promise;
        }

        if (isSingleUser === undefined && ctx.threadTypes) {
            isSingleUser = ctx.threadTypes[String(threadID)] === "dm";
        }

        var hasContent =
            (msg.body != null && String(msg.body).length > 0) ||
            msg.attachment || msg.sticker || msg.emoji || msg.location ||
            (msg.forwardAttachmentIds && msg.forwardAttachmentIds.length);
        if (!hasContent) {
            var emptyErr = new Error("Message must have body, attachment, sticker, emoji or location");
            if (callback) callback(emptyErr);
            else reject(emptyErr);
            return promise;
        }

        await waitTurn();

        if (isSingleUser && msg.attachment) {
            var useE2EE = api.e2ee && typeof api.e2ee.isConnected === "function" && api.e2ee.isConnected();
            if (useE2EE) {
                try {
                    var e2eeResult = await api.e2ee.sendMessage(String(threadID), msg, replyToMessage || msg.replyToMessage);
                    var wrapped = e2eeResult && e2eeResult.messageId
                        ? { threadID: String(threadID), messageID: String(e2eeResult.messageId) }
                        : e2eeResult;
                    if (callback) callback(null, wrapped);
                    else resolve(wrapped);
                } catch (e2eeErr) {
                    logger.error("sendMessage", "E2EE DM attachment send failed: " + (e2eeErr.message || e2eeErr));
                    if (callback) callback(e2eeErr);
                    else reject(e2eeErr);
                }
            } else {
                try {
                    var omResult = await sendViaOldMessage(msg, threadID, replyToMessage, isSingleUser);
                    if (callback) callback(null, omResult);
                    else resolve(omResult);
                } catch (omErr) {
                    logger.error("sendMessage", "DM attachment OldMessage failed: " + (omErr.message || omErr));
                    if (callback) callback(omErr);
                    else reject(omErr);
                }
            }
            return promise;
        }

        if (isSingleUser && !msg.attachment && !msg.sticker && !msg.location && !msg.emoji &&
            api.e2ee && typeof api.e2ee.isConnected === "function" && api.e2ee.isConnected()) {
            if (getTextEffectId(msg)) {

                if (process.env.FCA_NX_E2EE_EFFECT_VIA_MQTT !== "0") {
                    try {
                        var fxResult = await sendViaMqtt(msg, threadID, replyToMessage, 8000);
                        if (fxResult && !fxResult.threadID) fxResult.threadID = String(threadID);
                        if (callback) callback(null, fxResult);
                        else resolve(fxResult);
                        return promise;
                    } catch (fxErr) {
                        logger.warn("sendMessage", "Effect via MQTT failed in E2EE DM, sending plain E2EE text: " + (fxErr.message || fxErr));
                    }
                } else {
                    logger.warn("sendMessage", "Text effects are not supported in E2EE DMs - sending plain text. Use a group chat for effects.");
                }
            }
            try {
                var e2eeText = await api.e2ee.sendMessage(
                    String(threadID),
                    { body: msg.body != null ? String(msg.body) : "" },
                    replyToMessage || msg.replyToMessage
                );
                var e2eeWrapped = e2eeText && e2eeText.messageId
                    ? { threadID: String(threadID), messageID: String(e2eeText.messageId) }
                    : e2eeText;
                if (ctx.threadTypes) ctx.threadTypes[String(threadID)] = "dm";
                if (callback) callback(null, e2eeWrapped);
                else resolve(e2eeWrapped);
                return promise;
            } catch (e2eeTextErr) {
                logger.warn(
                    "sendMessage",
                    "E2EE DM text failed, cascading to MQTT/HTTP: " + (e2eeTextErr.message || e2eeTextErr)
                );

            }
        }

        try {
            var result = await sendViaMqtt(msg, threadID, replyToMessage, 18000);
            if (result && !result.threadID) result.threadID = String(threadID);
            if (callback) callback(null, result);
            else resolve(result);
        } catch (mqttErr) {
            logger.warn("sendMessage", "MQTT failed, falling back to OldMessage: " + (mqttErr.message || mqttErr));
            try {
                var fbResult = await sendViaOldMessage(msg, threadID, replyToMessage, isSingleUser);
                if (callback) callback(null, fbResult);
                else resolve(fbResult);
            } catch (fbErr) {
                logger.error("sendMessage", fbErr.error || fbErr.message || fbErr);
                if (callback) callback(fbErr);
                else reject(fbErr);
            }
        }

        return promise;
    };
};