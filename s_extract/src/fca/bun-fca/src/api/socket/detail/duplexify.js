"use strict";

const { Duplex, Writable } = require("stream");

function createDuplexify(opts = {}) {
  let target = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
    autoDestroy: false
  });
  let source = null;

  const dup = new Duplex({
    allowHalfOpen: false,
    autoDestroy: true,
    emitClose: true,
    ...opts,
    read() {

      if (source && typeof source.isPaused === "function" && source.isPaused()) {
        source.resume();
      }
    },
    write(chunk, enc, cb) {
      if (!target || target.writableEnded) return cb();
      try {
        target.write(chunk, enc, cb);
      } catch (e) {
        cb(e);
      }
    },
    final(cb) {
      try {
        if (target && !target.writableEnded) target.end();
      } catch (_) { }
      cb();
    }
  });

  dup.setWritable = (w) => {
    if (w && typeof w.write === "function") target = w;
  };

  dup.setReadable = (r) => {
    if (source) {
      try {
        source.pause();
        source.removeListener("data", onData);
        source.removeListener("end", onEnd);
        source.removeListener("error", onError);
      } catch (_) { }
    }
    source = r;
    if (!r) {
      dup.push(null);
      return;
    }
    r.on("data", onData);
    r.on("end", onEnd);
    r.on("error", onError);
  };

  function onData(chunk) {
    if (!dup.push(chunk)) {
      if (typeof source.pause === "function") source.pause();
    }
  }

  function onEnd() {
    dup.push(null);
  }

  function onError(err) {
    dup.destroy(err);
  }

  return dup;
}

module.exports = createDuplexify;