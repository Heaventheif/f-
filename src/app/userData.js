// In-memory usersData persisted through the kv store (namespace "users").
// setUserData writes one entry; flushUsersData writes every dirty entry.
const strip = (v) => {
  const { _dirty, _lastSeen, ...rest } = v || {};
  return rest;
};

export function createUserData({ usersData, getNs }) {
  let nsPromise;
  const ns = () => (nsPromise ??= getNs());
  return {
    async getUserData(key) {
      const mem = usersData.get(key);
      if (mem) {
        mem._lastSeen = Date.now();
        return mem;
      }
      const stored = await (await ns()).get(key);
      if (!stored) return {};
      const entry = { ...stored, _dirty: false, _lastSeen: Date.now() };
      usersData.set(key, entry);
      return entry;
    },
    async setUserData(key, data) {
      await (await ns()).set(String(key), strip(data));
    },
    async flushUsersData() {
      const store = await ns();
      let n = 0;
      for (const [key, entry] of [...usersData.entries()]) {
        if (!entry?._dirty) continue;
        await store.set(key, strip(entry));
        const cur = usersData.get(key);
        if (cur === entry) cur._dirty = false;
        n++;
      }
      return n;
    },
  };
}

export function installUserData(g = globalThis) {
  const ud = createUserData({
    usersData: g.usersData,
    getNs: async () => (await (await import("../state/kv.js")).getStore()).ns("users"),
  });
  g.getUserData = ud.getUserData;
  g.setUserData = ud.setUserData;
  g.flushUsersData = ud.flushUsersData;
  return ud;
}
