"use strict";

const state = { last: 0, chain: Promise.resolve(), delay: null, jitter: null, stamps: [] };

function maxPerMin() {
  const n = Number(process.env.FCA_NX_SEND_MAX_PER_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

function readNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

function getDelay() {
  return state.delay != null ? state.delay : readNum(process.env.FCA_NX_SEND_DELAY_MS, 1000);
}
function getJitter() {
  return state.jitter != null ? state.jitter : readNum(process.env.FCA_NX_SEND_JITTER_MS, 400);
}

function setSendDelay(ms, jitterMs) {
  if (ms != null) state.delay = readNum(ms, 1000);
  if (jitterMs != null) state.jitter = readNum(jitterMs, 400);
  return { delay: getDelay(), jitter: getJitter() };
}

function waitTurn() {
  const delay = getDelay();
  if (delay <= 0) return Promise.resolve();
  const turn = state.chain.then(async () => {
    const gap = delay + Math.floor(Math.random() * (getJitter() + 1));
    const wait = state.last + gap - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const cap = maxPerMin();
    if (cap > 0) {
      for (;;) {
        const now = Date.now();
        state.stamps = state.stamps.filter(t => now - t < 60000);
        if (state.stamps.length < cap) break;
        await new Promise(r => setTimeout(r, state.stamps[0] + 60000 - now + 50));
      }
      state.stamps.push(Date.now());
    }
    state.last = Date.now();
  });
  state.chain = turn.catch(() => {});
  return turn;
}

module.exports = { waitTurn, setSendDelay };