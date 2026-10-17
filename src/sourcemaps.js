"use strict";

const http = require("http");
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");

const MAX_MAP_BYTES = 200 * 1024 * 1024;

function fetchText(urlString, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const request = http.get(urlString, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_MAP_BYTES) {
          request.destroy(new Error("sourcemap grande demais"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout ao buscar sourcemap")));
    request.on("error", reject);
  });
}

// Traduz posições do bundle do dev server para o arquivo original. Só busca no origin do app (localhost).
function createSourceMapper({ appOrigin, ttlMs = 30000 }) {
  const cache = new Map(); // url -> { at, promise }

  function load(scriptUrl) {
    const clean = scriptUrl.split(/[?#]/)[0];
    const hit = cache.get(clean);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = fetchText(`${clean}.map`)
      .then((text) => (text ? new TraceMap(text) : null))
      .catch(() => null);
    cache.set(clean, { at: Date.now(), promise });
    return promise;
  }

  return {
    clear() {
      cache.clear();
    },
    // line0/column0: como o CDP entrega (0-based). Retorna { source, line, column } (line 1-based) ou null.
    async mapFrame(scriptUrl, line0, column0) {
      let origin;
      try {
        origin = new URL(scriptUrl).origin;
      } catch {
        return null;
      }
      if (origin !== appOrigin) return null;
      const traced = await load(scriptUrl);
      if (!traced) return null;
      const pos = originalPositionFor(traced, { line: line0 + 1, column: Math.max(0, column0) });
      if (!pos || !pos.source) return null;
      return { source: pos.source, line: pos.line, column: pos.column };
    },
  };
}

module.exports = { createSourceMapper };
