"use strict";

const enabled =
  process.env.NO_COLOR === undefined &&
  (process.stdout && process.stdout.isTTY) !== false &&
  process.env.TERM !== "dumb";

function wrap(open, close) {
  if (!enabled) return (s) => String(s);
  const o = `\x1b[${open}m`;
  const c = `\x1b[${close}m`;
  return (s) => o + String(s) + c;
}

function hex(hexColor) {

  if (!enabled) return (s) => String(s);
  const map = {
    "#ffb000": "93",
    "#ff3b30": "91",
    "#00ff88": "92",
    "#8888ff": "94",
    "#1affa3": "92",
    "#00d9ff": "96",
    "#7b61ff": "95",
    "#ff4fd8": "95",
    "#ffcc00": "93",
    "#ff2100": "91",
    "#ff6a00": "91",
    "#ffd000": "93"
  };
  const code = map[String(hexColor).toLowerCase()] || "97";
  return wrap(code, 39);
}

const chalk = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  grey: wrap(90, 39),
  hex,
};

module.exports = chalk;