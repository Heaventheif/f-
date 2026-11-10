"use strict";

function createCacheStore(maxEntries = 2000) {
  const rows = new Map();

  function touch(id, payload, prev) {
    return {
      id: String(id),
      data: (payload && payload.data !== undefined ? payload.data : (prev && prev.data) || null),
      updatedAt: new Date().toISOString()
    };
  }

  return {
    async create(id, payload) {
      const row = touch(id, payload, null);
      if (rows.size >= maxEntries) {
        const firstKey = rows.keys().next().value;
        rows.delete(firstKey);
      }
      rows.set(String(id), row);
      return row;
    },

    async get(id) {
      return rows.get(String(id)) || null;
    },

    async update(id, payload) {
      const key = String(id);
      const row = touch(id, payload, rows.get(key));
      rows.set(key, row);
      return row;
    },

    _rows: rows
  };
}

function cacheStores(_api) {
  return {
    threadData: createCacheStore(),
    userData: createCacheStore()
  };
}

module.exports = { cacheStores, createCacheStore };