"use strict";

const http = require("http");
const crypto = require("crypto");

function verifySignature(raw, header, appSecret) {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const providedHex = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(raw).digest();
  const provided = Buffer.from(providedHex, "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const e = new Error("Webhook payload too large");
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeEvents(payload) {
  if (!payload || payload.object !== "page" || !Array.isArray(payload.entry)) return [];
  const out = [];
  for (const entry of payload.entry) {
    for (const item of entry.messaging || []) {
      const senderID = String((item.sender && item.sender.id) || "");
      const recipientID = String((item.recipient && item.recipient.id) || "");
      const base = {
        senderID,
        threadID: senderID,
        recipientID,
        timestamp: item.timestamp || Date.now()
      };
      if (item.message) {
        out.push({
          ...base,
          type: "message",
          body: item.message.text || "",
          messageID: item.message.mid || "",
          attachments: item.message.attachments || [],
          isEcho: !!item.message.is_echo,
          quickReply: (item.message.quick_reply && item.message.quick_reply.payload) || null,
          raw: item
        });
      } else if (item.postback) {
        out.push({ ...base, type: "postback", payload: item.postback.payload || "", raw: item });
      } else if (item.read) {
        out.push({ ...base, type: "read", watermark: item.read.watermark, raw: item });
      } else if (item.delivery) {
        out.push({ ...base, type: "delivery", watermark: item.delivery.watermark, raw: item });
      } else if (item.reaction) {
        out.push({ ...base, type: "reaction", reaction: item.reaction, raw: item });
      }
    }
  }
  return out;
}

function attachPageWebhook(api, config = {}, events = null) {
  const webhookPath = String(config.path || "/webhook");
  const verifyToken = String(config.verifyToken || "");
  const appSecret = config.appSecret ? String(config.appSecret) : null;
  const port = Number(config.port || 3000);
  const host = config.host || "0.0.0.0";

  if (!verifyToken) {
    throw new Error("attachPageWebhook: verifyToken is required (set it in Meta's webhook config)");
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== webhookPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    if (req.method === "GET") {

      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === verifyToken && challenge !== null) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end("Forbidden");
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    try {
      const raw = await readBody(req, config.maxBodyBytes || 1024 * 1024);
      if (appSecret && !verifySignature(raw, req.headers["x-hub-signature-256"], appSecret)) {
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }
      const payload = JSON.parse(raw.toString("utf8"));
      const normalized = normalizeEvents(payload);
      res.writeHead(200);
      res.end("EVENTS_RECEIVED");
      for (const evt of normalized) {
        if (events && typeof events.emit === "function") events.emit(evt.type, evt);
        if (api && api.events && api.events !== events && typeof api.events.emit === "function") {
          api.events.emit(evt.type, evt);
        }
      }
    } catch (e) {
      res.writeHead(e.status || 400);
      res.end(e.status === 413 ? "Payload too large" : "Bad Request");
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end("Internal Error");
      } catch (_) { }
    });
  });

  return {
    server,
    port,
    path: webhookPath,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(this));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

module.exports = { attachPageWebhook, normalizeEvents, verifySignature };