const fs = require("fs");
const path = require("path");
const logger = require("../func/logger");
const defaultConfig = {

  autoUpdate: false,
  autoUpdateCheck: false,
  mqtt: { enabled: true, reconnectInterval: 3600 },
  autoLogin: true,

  apiServer: "",
  apiKey: "",
  credentials: { email: "", password: "", twofactor: "" },
  antiGetInfo: {
    AntiGetThreadInfo: false,
    AntiGetUserInfo: false
  },

  webhook: {
    enabled: false,
    port: 3000,
    path: "/webhook",
    verifyToken: "",
    appSecret: ""
  }
};

function loadConfig() {
  const configPath = path.join(process.cwd(), "fca-config.json");
  let config;
  if (!fs.existsSync(configPath)) {
    config = defaultConfig;
  } else {
    try {
      const fileContent = fs.readFileSync(configPath, "utf8");
      config = Object.assign({}, defaultConfig, JSON.parse(fileContent));
    } catch (err) {
      logger(`Error reading config file: ${err.message}`, "error");
      config = defaultConfig;
    }
  }
  return { config, configPath };
}

module.exports = { loadConfig, defaultConfig };