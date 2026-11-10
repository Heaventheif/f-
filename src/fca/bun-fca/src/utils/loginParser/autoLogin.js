"use strict";

const logger = require("../../../func/logger");

function createMaybeAutoLogin(ctx, http, helpers, emit, parseAndCheckLogin) {
  const { buildUrl, headerOf, formatCookie } = helpers;

  return async function maybeAutoLogin(resData, resConfig) {
    const retryAfterLogin = async function () {
      if (!resConfig) {
        const e = new Error(
          "Not logged in. Auto login successful but cannot retry request."
        );
        e.error = "Not logged in.";
        e.res = resData;
        throw e;
      }

      const url = buildUrl(resConfig);
      const method = String(resConfig?.method || "GET").toUpperCase();
      const ctype = String(headerOf(resConfig?.headers, "content-type") || "").toLowerCase();
      const isMultipart = ctype.includes("multipart/form-data");
      const payload = resConfig?.data;
      const params = resConfig?.params;

      try {
        let newData;
        if (method === "GET") {
          newData = await http.get(url, ctx.jar, params || null, ctx.globalOptions, ctx);
        } else if (isMultipart) {
          newData = await http.postFormData(url, ctx.jar, payload, params, ctx.globalOptions, ctx);
        } else {
          newData = await http.post(url, ctx.jar, payload, ctx.globalOptions, ctx);
        }
        return await parseAndCheckLogin(ctx, http)(newData);
      } catch (retryErr) {
        if (
          retryErr?.code === "ERR_INVALID_CHAR" ||
          (retryErr?.message && retryErr.message.includes("Invalid character in header"))
        ) {
          logger(
            `Auto login retry failed: Invalid header detected. Error: ${retryErr.message}`,
            "error"
          );
          const e = new Error("Not logged in. Auto login retry failed due to invalid header.");
          e.error = "Not logged in.";
          e.res = resData;
          e.originalError = retryErr;
          throw e;
        }
        logger(
          `Auto login retry failed: ${
            retryErr && retryErr.message ? retryErr.message : String(retryErr)
          }`,
          "error"
        );
        const e = new Error("Not logged in. Auto login retry failed.");
        e.error = "Not logged in.";
        e.res = resData;
        e.originalError = retryErr;
        throw e;
      }
    };

    if (ctx._autoLoginPromise) {
      let ok;
      try {
        ok = await ctx._autoLoginPromise;
      } catch (autoLoginErr) {
        const e = new Error("Not logged in. Auto login failed.");
        e.error = "Not logged in.";
        e.res = resData;
        e.originalError = autoLoginErr;
        throw e;
      }
      if (!ok) {
        const e = new Error("Not logged in. Auto login failed.");
        e.error = "Not logged in.";
        e.res = resData;
        throw e;
      }
      return retryAfterLogin();
    }

    if (typeof ctx.performAutoLogin !== "function") {
      const e = new Error("Not logged in. Auto login function not available.");
      e.error = "Not logged in.";
      e.res = resData;
      throw e;
    }

    ctx.auto_login = true;
    logger("Login session expired, attempting auto login...", "warn");
    emit("sessionExpired", { res: resData });

    const autoLoginPromise = Promise.resolve().then(() => ctx.performAutoLogin());
    ctx._autoLoginPromise = autoLoginPromise;

    try {
      const ok = await autoLoginPromise;
      if (ok) {
        logger("Auto login successful! Retrying request...", "info");
        emit("autoLoginSuccess", { res: resData });
        return retryAfterLogin();
      } else {
        const e = new Error("Not logged in. Auto login failed.");
        e.error = "Not logged in.";
        e.res = resData;
        emit("autoLoginFailed", { error: e, res: resData });
        throw e;
      }
    } catch (autoLoginErr) {
      if (autoLoginErr.error === "Not logged in.") {
        throw autoLoginErr;
      }
      logger(
        `Auto login error: ${
          autoLoginErr && autoLoginErr.message ? autoLoginErr.message : String(autoLoginErr)
        }`,
        "error"
      );
      const e = new Error("Not logged in. Auto login error.");
      e.error = "Not logged in.";
      e.res = resData;
      e.originalError = autoLoginErr;
      emit("autoLoginFailed", { error: e, res: resData });
      throw e;
    } finally {
      ctx.auto_login = false;
      if (ctx._autoLoginPromise === autoLoginPromise) {
        ctx._autoLoginPromise = null;
      }
    }
  };
}

module.exports = {
  createMaybeAutoLogin
};