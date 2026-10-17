"use strict";

const WebSocket = require("ws");

const CALL_TIMEOUT_MS = 15000;

// Cliente mínimo do Chrome DevTools Protocol (um alvo por conexão).
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const pending = new Map();
    const handlers = new Map();
    const closeHandlers = [];
    let nextId = 0;
    let opened = false;

    const client = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          if (ws.readyState !== WebSocket.OPEN) return rej(new Error("CDP desconectado"));
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP timeout em ${method}`));
          }, CALL_TIMEOUT_MS);
          pending.set(id, { res, rej, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
      close() {
        try {
          ws.close();
        } catch {
          // já fechado
        }
      },
    };

    ws.on("open", () => {
      opened = true;
      resolve(client);
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id != null) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.rej(new Error(message.error.message || "erro CDP"));
        else entry.res(message.result);
      } else if (message.method) {
        for (const handler of handlers.get(message.method) || []) {
          try {
            handler(message.params || {});
          } catch (error) {
            console.error(`[src-map] handler ${message.method}: ${error.message}`);
          }
        }
      }
    });
    ws.on("close", () => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer);
        rej(new Error("CDP desconectado"));
      }
      pending.clear();
      for (const handler of closeHandlers) handler();
    });
    ws.on("error", (error) => {
      if (!opened) reject(error);
    });
  });
}

module.exports = { connect };
