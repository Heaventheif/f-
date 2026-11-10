"use strict";

const log = require("../../../func/logAdapter");
const { parseAndCheckLogin } = require("../../utils/client");

module.exports = function (defaultFuncs, api, ctx) {
  return function getThemePictures(id, callback) {
    let resolveFunc = function () { };
    let rejectFunc = function () { };
    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (typeof callback !== "function") {
      callback = function (err, data) {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    if (typeof id === "number" || typeof id === "bigint") id = String(id);
    id = typeof id === "string" ? id.trim() : "";

    if (!/^\d+$/.test(id)) {
      const err = {
        error: "getThemePictures: a numeric theme ID is required (theme_fbid), got: " + JSON.stringify(id)
      };
      callback(err);
      return returnPromise;
    }

    const form = {
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "MWPThreadThemeProviderQuery",
      doc_id: "9734829906576883",
      server_timestamps: true,
      variables: JSON.stringify({ id }),
      av: ctx.userID
    };

    defaultFuncs
      .post("https://www.facebook.com/api/graphql/", ctx.jar, form)
      .then(parseAndCheckLogin(ctx, defaultFuncs))
      .then(function (resData) {
        if (resData && resData.errors) {
          throw resData;
        }

        if (!resData || !resData.data || !resData.data.messenger_thread_theme) {
          const notFound = {
            error: "Theme not found: Facebook returned no theme for ID " + id + ". Check the ID (use the theme_fbid of a real theme).",
            themeID: id,
            raw: resData
          };
          log.error("getThemePictures", notFound.error);
          return callback(notFound);
        }

        return callback(null, resData);
      })
      .catch(function (err) {
        log.error("getThemePictures", err);
        return callback(err);
      });

    return returnPromise;
  };
};