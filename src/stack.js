"use strict";

const fs = require("fs");
const path = require("path");

// Frames de infraestrutura HTTP: encanamento, não é "quem chamou" no caso de erro HTTP.
const INFRA_PREFIXES = ["services/api/http/"];
const MAX_PATH_FRAMES = 12;
const RENDER_FRAMES = /^(renderWithHooks|beginWork|performUnitOfWork|mountIndeterminateComponent|updateFunctionComponent|updateClassComponent|invokeGuardedCallbackDev|mountClassInstance)/;

const isInfra = (file) => INFRA_PREFIXES.some((prefix) => file.startsWith(prefix));

function flattenStack(stackTrace) {
  const frames = [];
  let current = stackTrace;
  let guard = 0;
  while (current && guard++ < 10) {
    frames.push(...(current.callFrames || []));
    current = current.parent;
  }
  return frames;
}

function toSrcRel(source, srcDir) {
  const normalized = source.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/")) return null;
  const match = normalized.match(/\/src\/(.+?)(?:\?.*)?$/);
  if (!match) return null;
  const rel = match[1];
  return fs.existsSync(path.join(srcDir, rel)) ? rel : null;
}

function cleanFnName(name) {
  if (!name) return null;
  const clean = name.replace(/^async\s+/, "").replace(/^Object\./, "");
  return !clean || clean.includes("/") ? null : clean; // "./src/Foo.js" é frame de módulo, sem função
}

async function resolveFrames(callFrames, { mapper, srcDir }) {
  const out = [];
  for (const cf of callFrames) {
    if (!cf.url) continue;
    const pos = await mapper.mapFrame(cf.url, cf.lineNumber, cf.columnNumber);
    if (!pos) continue;
    const file = toSrcRel(pos.source, srcDir);
    if (!file) continue;
    out.push({ file, line: pos.line, fn: cleanFnName(cf.functionName) });
  }
  return out;
}

// Exceção: a função que realmente lançou (frame mais interno em src/, infra incluída).
// HTTP: o primeiro frame de src/ que não seja infra (quem fez a chamada).
function pickCulprit(frames, kind) {
  if (!frames.length) return { culprit: null, path: [] };
  const culprit = kind === "http" ? frames.find((f) => !isInfra(f.file)) || frames[0] : frames[0];
  const seen = new Set([`${culprit.file}:${culprit.line}`]);
  const rest = [];
  for (const f of frames) {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rest.push(f);
    if (rest.length >= MAX_PATH_FRAMES) break;
  }
  return { culprit, path: rest };
}

function looksLikeRenderError(callFrames) {
  return callFrames.some((cf) => RENDER_FRAMES.test(cf.functionName || ""));
}

// Troca segmentos que parecem dado (id numérico, uuid, hash, e-mail, CPF) por :id. Nunca devolve query string.
function sanitizeSegment(segment) {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // mantém como veio
  }
  if (!s) return s;
  if (s.includes("@")) return ":id";
  if (/^\d+$/.test(s)) return ":id";
  if (/\d{6,}/.test(s)) return ":id";
  if (/^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$/i.test(s)) return ":id";
  if (/^\d[\d.\-/]*$/.test(s)) return ":id";
  return segment;
}

function sanitizePath(pathname) {
  return pathname
    .split("/")
    .map(sanitizeSegment)
    .join("/");
}

function sanitizeEndpoint(urlString) {
  try {
    return sanitizePath(new URL(urlString).pathname);
  } catch {
    return null;
  }
}

module.exports = { flattenStack, resolveFrames, pickCulprit, looksLikeRenderError, sanitizePath, sanitizeEndpoint, isInfra, toSrcRel };
