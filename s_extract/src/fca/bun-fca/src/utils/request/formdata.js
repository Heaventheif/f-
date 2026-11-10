"use strict";

const { isStream } = require("./helpers");
const { lookupMime } = require("./mime");

const { Readable } = require("stream");

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function randomBoundary() {
  return "bunfca" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class FormData {
  constructor() {
    this.__isBunFcaFormData = true;
    this._parts = [];
    this._boundary = randomBoundary();
  }

  append(name, value, options) {
    if (value === undefined || value === null) return;
    const part = { name: String(name), options: options || {} };
    if (isStream(value)) {
      part.kind = "buffer";
      part.promise = streamToBuffer(value);
      if (!part.options.filename) part.options.filename = "file";
      part.options.contentType =
        part.options.contentType || lookupMime(part.options.filename) || "application/octet-stream";
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      part.kind = "buffer";
      part.buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (!part.options.filename) part.options.filename = "file";
      part.options.contentType =
        part.options.contentType || lookupMime(part.options.filename) || "application/octet-stream";
    } else if (typeof value === "object" && typeof value.arrayBuffer === "function") {

      part.kind = "blob";
      part.blob = value;
      if (!part.options.filename) part.options.filename = value.name || "file";
      part.options.contentType =
        part.options.contentType || value.type || lookupMime(part.options.filename) || "application/octet-stream";
    } else if (typeof value === "object") {
      part.kind = "field";
      part.value = JSON.stringify(value);
    } else {
      part.kind = "field";
      part.value = String(value);
    }
    this._parts.push(part);
  }

  async toFetchBody() {
    const chunks = [];
    const dash = Buffer.from("--" + this._boundary + "\r\n");

    for (const part of this._parts) {
      chunks.push(dash);
      let contentDisposition;
      let contentType;

      if (part.kind === "field") {
        contentDisposition = `form-data; name="${quote(part.name)}"`;
        contentType = part.options.contentType || null;
      } else {
        contentDisposition = `form-data; name="${quote(part.name)}"; filename="${quote(part.options.filename || "file")}"`;
        contentType = part.options.contentType || "application/octet-stream";
      }

      let header = `Content-Disposition: ${contentDisposition}\r\n`;
      if (contentType) header += `Content-Type: ${contentType}\r\n`;
      chunks.push(Buffer.from(header + "\r\n"));

      if (part.kind === "field") {
        chunks.push(Buffer.from(String(part.value), "utf8"));
      } else if (part.kind === "buffer") {
        chunks.push(part.promise ? await part.promise : part.buffer);
      } else if (part.kind === "blob") {
        chunks.push(Buffer.from(await part.blob.arrayBuffer()));
      }
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from("--" + this._boundary + "--\r\n"));

    const buf = Buffer.concat(chunks);
    const body =
      typeof Blob !== "undefined"
        ? new Blob([buf])
        : buf;
    return {
      body,
      contentType: `multipart/form-data; boundary=${this._boundary}`,
      length: buf.length
    };
  }

  getHeaders() {
    return {
      "content-type": `multipart/form-data; boundary=${this._boundary}`
    };
  }

  async buffer() {
    const { body } = await this.toFetchBody();
    if (Buffer.isBuffer(body)) return body;
    return Buffer.from(await body.arrayBuffer());
  }

  get length() {

    let n = 0;
    for (const part of this._parts) {
      n += 4 + this._boundary.length + 2;
      if (part.kind === "field") {
        n += `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`.length + String(part.value).length + 2;
      } else {
        n +=
          (`Content-Disposition: form-data; name="${part.name}"; filename="${part.options.filename || "file"}"\r\n` +
            `Content-Type: ${part.options.contentType || "application/octet-stream"}\r\n\r\n`).length + 2;
        if (part.kind === "buffer" && part.buffer) n += part.buffer.length;
        else n += part.options.knownLength || 0;
      }
    }
    n += 6 + this._boundary.length + 2;
    return n;
  }

  pipe(dest) {
    Readable.from((async function* () {
      const buf = await this.buffer();
      yield buf;
    }).call(this)).pipe(dest);
    return dest;
  }
}

function quote(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

module.exports = FormData;