"use strict";

const { getFrom } = require("../../utils/constants");
const { get } = require("../../utils/request");
const { getType } = require("../../utils/format");
const logger = require("../../../func/logger");

function extractTokens(html) {
  if (!html || typeof html !== "string") return null;
  const fb_dtsg =
    getFrom(html, '["DTSGInitData",[],{"token":"', '","') ||
    getFrom(html, '"DTSGInitialData",[],{"token":"', '"') ||
    getFrom(html, 'name="fb_dtsg" value="', '"') ||
    getFrom(html, '"fb_dtsg":{"token":"', '"') ||
    getFrom(html, "fb_dtsg\":{\"token\":\"", "\"") ||
    null;
  const jazoest =
    getFrom(html, "jazoest=", '",') ||
    getFrom(html, 'name="jazoest" value="', '"') ||
    getFrom(html, '"jazoest":"', '"') ||
    null;
  if (!fb_dtsg) return null;
  return { fb_dtsg, jazoest: jazoest || (ctxJazoestFallback(fb_dtsg)) };
}

function ctxJazoestFallback(token) {

  let sum = 0;
  for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i);
  return "2" + sum;
}

module.exports = function (defaultFuncs, api, ctx) {
  return function refreshFb_dtsg(obj, callback) {
    if (typeof obj === "function") {
      callback = obj;
      obj = {};
    }
    if (!obj) obj = {};
    if (getType(obj) !== "Object") {
      throw new TypeError("The first parameter must be an object or a callback function");
    }
    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    if (!callback) {
      callback = (err, data) => (err ? rejectFunc(err) : resolveFunc(data));
    }

    if (Object.keys(obj).length > 0) {
      Object.assign(ctx, obj);
      callback(null, {
        data: obj,
        message: `Refreshed ${Object.keys(obj).join(", ")}`
      });
      return returnPromise;
    }

    const urls = [
      "https://www.facebook.com/",
      "https://www.facebook.com/messages/",
      "https://www.messenger.com/"
    ];

    (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const url of urls) {
          try {
            const res = await get(url, ctx.jar, null, ctx.globalOptions, { noRef: true });
            const html = typeof res === "string" ? res : res && res.data;
            const tokens = extractTokens(html);
            if (tokens && tokens.fb_dtsg) {
              Object.assign(ctx, { fb_dtsg: tokens.fb_dtsg, jazoest: tokens.jazoest });

              try {
                const { saveCookies } = require("../../utils/client");
                if (res && res.headers) saveCookies(ctx.jar)(res);
              } catch (_) {}
              callback(null, {
                data: { fb_dtsg: tokens.fb_dtsg, jazoest: tokens.jazoest },
                message: "Refreshed fb_dtsg and jazoest"
              });
              return;
            }
          } catch (e) {
            lastErr = e;
            logger(
              `refreshFb_dtsg attempt ${attempt + 1} ${url}: ${e && e.message ? e.message : e}`,
              "warn"
            );
          }
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
      const err = lastErr || new Error("Could not find fb_dtsg in HTML after multiple attempts.");
      logger(`refreshFb_dtsg failed: ${err.message || err}`, "error");
      callback(err);
    })();

    return returnPromise;
  };
};