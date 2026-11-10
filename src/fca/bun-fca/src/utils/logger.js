"use strict";

const C = {
    reset:    '\x1b[0m',
    bold:     '\x1b[1m',
    dim:      '\x1b[2m',
    black:    '\x1b[30m',
    red:      '\x1b[31m',
    green:    '\x1b[32m',
    yellow:   '\x1b[33m',
    blue:     '\x1b[34m',
    magenta:  '\x1b[35m',
    cyan:     '\x1b[36m',
    white:    '\x1b[37m',
    bBlack:   '\x1b[90m',
    bRed:     '\x1b[91m',
    bGreen:   '\x1b[92m',
    bYellow:  '\x1b[93m',
    bBlue:    '\x1b[94m',
    bMagenta: '\x1b[95m',
    bCyan:    '\x1b[96m',
    bWhite:   '\x1b[97m',
    bgRed:    '\x1b[41m',
    bgGreen:  '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue:   '\x1b[44m',
    bgMagenta:'\x1b[45m',
    bgCyan:   '\x1b[46m',
};

function ts() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${C.dim}${hh}:${mm}:${ss}.${ms}${C.reset}`;
}

function tag(label, color) {
    return `${color}${C.bold}[ ${label} ]${C.reset}`;
}

function fmt(msg) {
    if (typeof msg === 'object' && msg !== null) {
        try { return JSON.stringify(msg, null, 2); } catch (_) { return String(msg); }
    }
    return String(msg);
}

const logger = {
    info(label, msg) {
        if (msg === undefined) { msg = label; label = 'INFO'; }
        console.log(`${ts()} ${tag(label, C.bCyan)} ${C.white}${fmt(msg)}${C.reset}`);
    },
    success(label, msg) {
        if (msg === undefined) { msg = label; label = 'OK'; }
        console.log(`${ts()} ${tag(label, C.bGreen)} ${C.bWhite}${fmt(msg)}${C.reset}`);
    },
    warn(label, msg) {
        if (msg === undefined) { msg = label; label = 'WARN'; }
        console.warn(`${ts()} ${tag(label, C.bYellow)} ${C.yellow}${fmt(msg)}${C.reset}`);
    },
    error(label, msg) {
        if (msg === undefined) { msg = label; label = 'ERR'; }
        const body = msg instanceof Error ? msg.stack || msg.message : fmt(msg);
        console.error(`${ts()} ${tag(label, C.bRed)} ${C.red}${body}${C.reset}`);
    },
    debug(label, msg) {
        if (msg === undefined) { msg = label; label = 'DBG'; }
        console.log(`${ts()} ${tag(label, C.bBlack)} ${C.dim}${fmt(msg)}${C.reset}`);
    },
    event(label, msg) {
        if (msg === undefined) { msg = label; label = 'EVT'; }
        console.log(`${ts()} ${tag(label, C.bMagenta)} ${C.magenta}${fmt(msg)}${C.reset}`);
    },

    banner(name, version, userID, botName, region, autoReconnect) {
        console.log(`${C.bold}${C.bCyan}[ ${name} ]${C.reset} ${C.dim}v${version}${C.reset}`);
        console.log(`  Bot: ${botName ? `${C.bold}${botName}${C.reset} (${userID})` : userID}`);
        console.log(`  Region: ${(region || 'AUTO').toUpperCase()}  Transport: MQTT  Auto-Reconnect: ${autoReconnect ? 'Enabled' : 'Disabled'}`);
    },

    mqttSpinner: null,

    startSpinner(region) {
        const frames = ['|', '/', '-', '\\'];
        let fi = 0;
        const regionStr = region ? ` ${C.dim}${C.bCyan}[${region.toUpperCase()}]${C.reset}` : '';
        process.stdout.write('\n');
        logger.mqttSpinner = setInterval(() => {
            const f = frames[fi++ % frames.length];
            process.stdout.write(
                `\r  ${C.bold}${C.bCyan}${f}${C.reset}  ${C.cyan}bun-fca${C.reset} ` +
                `${C.dim}connecting to MQTT${C.reset}${regionStr}${C.dim} ...${C.reset}   `
            );
        }, 80);
    },

    stopSpinner() {
        if (logger.mqttSpinner) {
            clearInterval(logger.mqttSpinner);
            logger.mqttSpinner = null;
        }
        process.stdout.write('\r\x1b[2K');
    },
};

module.exports = logger;
module.exports.C = C;