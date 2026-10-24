"use strict";
function start(label) {
  const t0 = Date.now();
  const marks = [];
  let lastMark = t0;
  return {
    mark(name) {
      const now = Date.now();
      marks.push({ name, ms: now - lastMark });
      lastMark = now;
    },
    end(extra = "") {
      const total = Date.now() - t0;
      const breakdown = marks.length ? ` (${marks.map(m => `${m.name}=${m.ms}ms`).join(", ")})` : "";
      console.log(`[TIMING] ${label}: ${total}ms${breakdown}${extra ? " " + extra : ""}`);
      return total;
    },
  };
}
export { start };
export default { start };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-timing',
  meta: { category: 'utils', path: 'src/utils/timing.js' },
  setup(_ctx) {
    // provides: start
  },
};
