"use strict";

// Roda o indexador fora da thread do extension host (o parse de ~3.5k arquivos bloqueia por segundos).
// O worker fica vivo para reaproveitar o cache de parse entre reindexações.
const { parentPort } = require("worker_threads");
const { buildIndex } = require("./indexer");

parentPort.on("message", (message) => {
  if (message.type !== "index") return;
  try {
    parentPort.postMessage({ type: "index", id: message.id, index: buildIndex(message.srcDir) });
  } catch (error) {
    parentPort.postMessage({ type: "failed", id: message.id, message: error.message });
  }
});
