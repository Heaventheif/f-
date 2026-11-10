"use strict";

const log = require("../../../func/logAdapter");
const { parseAndCheckLogin } = require("../../utils/client");
const { formatID, getSignatureID } = require("../../utils/format");

const FRIEND_REQUEST_DOC_ID = "FriendingCometFriendRequestSendMutation";

module.exports = function (defaultFuncs, api, ctx) {
  return function addFriend(userID, callback) {
    let resolveFunc;
    let rejectFunc;

    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    const handleCallback = (err, data) => {
      if (typeof callback === "function") {
        callback(err, data);
      }
      if (err) {
        rejectFunc(err);
      } else {
        resolveFunc(data);
      }
    };

    let targetID;
    try {
      targetID = formatID(userID);
    } catch (err) {
      handleCallback(err);
      return returnPromise;
    }

    if (!targetID) {
      handleCallback(new Error("Invalid user ID"));
      return returnPromise;
    }

    if (String(targetID) === String(ctx.userID)) {
      handleCallback(new Error("You cannot send a friend request to yourself"));
      return returnPromise;
    }

    const sendRequest = async function () {

      if (!ctx.fb_dtsg && typeof api?.refreshFb_dtsg === "function") {
        try {
          await api.refreshFb_dtsg();
        } catch (_) {

        }
      }

      const actorID = String(ctx.i_userID || ctx.userID);
      const form = {
        av: actorID,
        __aaid: "0",
        __user: actorID,
        __a: "1",
        __req: getSignatureID(),
        __hs: "20353.HYP:comet_pkg.2.1...0",
        dpr: "1",
        __ccg: "EXCELLENT",
        __rev: "1027405870",
        __s: getSignatureID(),
        __hsi: "7552782279085106329",
        __comet_req: "15",
        fb_dtsg: ctx.fb_dtsg,
        jazoest: ctx.ttstamp || ctx.jazoest,
        lsd: ctx.fb_dtsg,
        __spin_r: "1027405870",
        __spin_b: "trunk",
        __spin_t: String(Date.now()),
        __crn: "comet.fbweb.CometFriendingRoute",
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "FriendingCometFriendRequestSendMutation",
        server_timestamps: true,
        doc_id: "24614631718227645",
        variables: JSON.stringify({
          input: {
            click_correlation_id: String(Date.now()),
            click_proof_validation_result: JSON.stringify({ validated: true }),
            friend_requestee_ids: [String(targetID)],
            friending_channel: "FRIENDS_HOME_MAIN",
            warn_ack_for_ids: [],
            actor_id: actorID,
            client_mutation_id: String(Math.floor(Math.random() * 100000))
          },
          scale: 1
        })
      };

      return defaultFuncs
        .post(
          "https://www.facebook.com/api/graphql/",
          ctx.jar,
          form
        )
        .then(parseAndCheckLogin(ctx, defaultFuncs));
    };

    sendRequest()
      .then(function (resData) {
        if (!resData) {
          throw new Error("Empty response from Facebook");
        }

        const payload = resData.payload || resData.data || resData;
        const errorValue =
          resData.error ||
          resData.errors ||
          resData.errorDescription ||
          payload?.error ||
          payload?.err ||
          payload?.errorDescription ||
          payload?.message;
        if (errorValue) {
          const error = new Error(
            typeof errorValue === "string"
              ? errorValue
              : errorValue.message || JSON.stringify(errorValue)
          );
          error.error = errorValue;
          error.res = resData;
          throw error;
        }

        const findRequestID = value => {
          if (!value || typeof value !== "object") return null;
          for (const key of ["friend_request_id", "friendRequestId", "request_id"]) {
            if (value[key]) return String(value[key]);
          }
          for (const child of Object.values(value)) {
            const nested = findRequestID(child);
            if (nested) return nested;
          }
          return null;
        };

        const response = Array.isArray(resData) ? resData[0] : resData;
        const data = response?.data?.friend_request_send ||
          response?.friend_request_send;
        const requestee = Array.isArray(data?.friend_requestees)
          ? data.friend_requestees[0]
          : null;
        const requestID = findRequestID(payload);
        if (!requestee && !requestID) {
          throw new Error("No friend request data received");
        }

        const result = {
          success: requestee
            ? requestee.friendship_status === "OUTGOING_REQUEST"
            : true,
          userID: requestee?.id || String(targetID)
        };
        if (requestee) {
          result.friendshipStatus = requestee.friendship_status || null;
          result.actionTitle = requestee.profile_action?.title?.text || null;
        }
        if (requestID) {
          result.requestID = requestID;
          result.response = response;
        }

        return handleCallback(null, result);
      })
      .catch(function (err) {
        log.error("addFriend", err?.message || err);
        return handleCallback(err);
      });

    return returnPromise;
  };
};
