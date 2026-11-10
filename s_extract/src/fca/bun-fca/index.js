"use strict";

const login = require("./module/login");
const { loginAsync, createModernClient } = require("./src/modern");
const { attachPageWebhook, normalizeEvents } = require("./src/features/webhook");
const { CookieJar } = require("./src/utils/request/cookiejar");
const { createClient } = require("./src/utils/request/client");
const pkg = require("./package.json");

module.exports = login;

const { createFcaClient } = require("./src/app/createFcaClient");
const { MessengerBot, createMessengerBot } = require("./src/app/MessengerBot");
const { MessengerContext } = require("./src/app/MessengerContext");
const {
  attachThreadInfoRealtimeSync,
  applyThreadInfoRealtimeEvent,
} = require("./src/app/threadInfoRealtimeSync");

module.exports.login = login;
module.exports.default = login;
module.exports.loginAsync = loginAsync;
module.exports.createModernClient = createModernClient;
module.exports.attachPageWebhook = attachPageWebhook;
module.exports.normalizePageEvents = normalizeEvents;
module.exports.CookieJar = CookieJar;
module.exports.createHttpClient = createClient;
module.exports.createFcaClient = createFcaClient;
module.exports.MessengerBot = MessengerBot;
module.exports.createMessengerBot = createMessengerBot;
module.exports.MessengerContext = MessengerContext;
module.exports.attachThreadInfoRealtimeSync = attachThreadInfoRealtimeSync;
module.exports.applyThreadInfoRealtimeEvent = applyThreadInfoRealtimeEvent;
module.exports.version = pkg.version;
module.exports.pkg = pkg;