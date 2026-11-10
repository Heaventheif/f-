"use strict";

const chalk = require("./colors");

function formatPrefix(type) {
  const name = String(type || "INFO").toUpperCase();

  if (name === "WARN") {
    return chalk.bold.hex("#ffb000")("[ bun-fca ]");
  }

  if (name === "ERROR") {
    return chalk.bold.hex("#ff3b30")("[ bun-fca ]");
  }

  if (name === "SUCCESS") {
    return chalk.bold.hex("#00ff88")("[ bun-fca ]");
  }

  if (name === "DEBUG") {
    return chalk.bold.hex("#8888ff")("[ bun-fca ]");
  }

  return chalk.bold.hex("#00d9ff")("[ bun-fca ]");
}

function formatMessage(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\n+/g, "\n");
}

function logger(text, type = "info") {
  try {
    const message = formatMessage(text);
    const prefix = formatPrefix(type);
    process.stderr.write(`${prefix} ${chalk.dim("›")} ${message}\n`);
  } catch (_) {

  }
}

module.exports = logger;