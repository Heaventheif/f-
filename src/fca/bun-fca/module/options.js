const { getType } = require("../src/utils/format");
const { setProxy } = require("../src/utils/request");
const logger = require("../func/logger");
const { getIdentity } = require("../src/utils/clientIdentity");
const Boolean_Option = [
  "online",
  "selfListen",
  "listenEvents",
  "updatePresence",
  "forceLogin",
  "autoMarkRead",
  "listenTyping",
  "autoReconnect",
  "emitReady",
  "selfListenEvent"
];
function setOptions(globalOptions, options) {
  for (const key of Object.keys(options || {})) {
    if (Boolean_Option.includes(key)) {
      globalOptions[key] = Boolean(options[key]);
      continue;
    }
    switch (key) {
      case "userAgent": {

        globalOptions.userAgent = getIdentity(options.userAgent).userAgent;
        break;
      }
      case "proxy": {
        if (typeof options.proxy !== "string") {
          delete globalOptions.proxy;
          setProxy();
        } else {
          globalOptions.proxy = options.proxy;
          setProxy(globalOptions.proxy);
        }
        break;
      }
      default: {
        logger("setOptions Unrecognized option given to setOptions: " + key, "warn");
        break;
      }
    }
  }
}
module.exports = { setOptions, Boolean_Option };