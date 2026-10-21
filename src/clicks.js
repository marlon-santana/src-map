"use strict";

const { toSrcRel } = require("./stack");

const CLICK_BINDING = "__srcMapClick";
const MAX_CHAIN = 8;

// Roda dentro da página (injetado via CDP; o repo do app não é tocado). Escuta o clique em fase de captura,
// sem impedir nem alterar nada, e sobe pelos fibers do React até o primeiro que tenha `_debugSource` em src/
// — o JSX onde o elemento clicado foi escrito. Só nomes de componente/tag, arquivo:linha e data-testid saem
// daqui: texto, valores, classes, href e aria-label nunca são lidos.
const CLICK_HOOK = `(() => {
  if (window.__srcMapHook || window !== window.top) return;
  window.__srcMapHook = true;
  const MAX_VISIT = 600;
  const MAX_CHAIN = ${MAX_CHAIN};
  const fiberOf = (node) => {
    for (const key in node) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key];
    return null;
  };
  const nameOf = (type, depth = 0) => {
    if (!type || depth > 3) return null;
    if (typeof type === 'string') return type;
    return type.displayName || type.name || nameOf(type.render, depth + 1) || nameOf(type.type, depth + 1) || null;
  };
  const inSrc = (source) => {
    const file = source && typeof source.fileName === 'string' ? source.fileName.replace(/\\\\/g, '/') : '';
    return file.includes('/src/') && !file.includes('/node_modules/');
  };
  const entry = (name, source) => ({
    n: String(name || '').slice(0, 60),
    f: source && typeof source.fileName === 'string' ? source.fileName.slice(0, 400) : null,
    l: source && Number.isInteger(source.lineNumber) ? source.lineNumber : null,
  });
  window.addEventListener('click', (event) => {
    try {
      if (!event.isTrusted || typeof window.__srcMapClick !== 'function') return;
      let target = event.target;
      if (target && target.nodeType !== 1) target = target.parentElement;
      if (!target) return;
      let node = target;
      let fiber = null;
      while (node && !(fiber = fiberOf(node))) node = node.parentElement;
      if (!fiber) return;
      let pick = fiber;
      let climbed = 0;
      while (pick && !inSrc(pick._debugSource) && climbed < MAX_VISIT) {
        pick = pick.return;
        climbed++;
      }
      if (!pick) return;
      const element = entry(nameOf(pick.type), pick._debugSource);
      element.host = typeof pick.type === 'string';
      element.inner = pick !== fiber;
      // Cada dono vem com a linha, dentro dele, onde renderizou o filho anterior (= arquivo onde o dono está definido).
      const chain = [];
      let source = pick._debugSource;
      let owner = pick._debugOwner;
      while (owner && chain.length < MAX_CHAIN) {
        chain.push(entry(nameOf(owner.type), source));
        source = owner._debugSource;
        owner = owner._debugOwner;
      }
      const withTestId = target.closest && target.closest('[data-testid]');
      window.__srcMapClick(JSON.stringify({
        tag: String(target.tagName || '').toLowerCase().slice(0, 30),
        testId: withTestId ? String(withTestId.getAttribute('data-testid') || '').slice(0, 120) : null,
        element,
        chain,
      }));
    } catch (error) {
      // nunca atrapalha o app
    }
  }, true);
})()`;

const NAME = /^[A-Za-z_$][\w$.()<>\- ]{0,59}$/;
const TAG = /^[a-z][a-z0-9-]{0,29}$/;

const safeName = (value) => (typeof value === "string" && NAME.test(value) ? value : null);

// data-testid é escrito pelo dev, mas pode embutir id de registro (ex.: "row-48211"): troca por :id.
function sanitizeTestId(value) {
  if (typeof value !== "string" || !value || value.includes("@")) return null;
  const clean = value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\d{3,}/g, ":id")
    .trim();
  return /^[\w\-:. ]{1,80}$/.test(clean) ? clean : null;
}

const safeLine = (value) => (Number.isInteger(value) && value > 0 && value < 1e6 ? value : null);

function resolveSource(entry, srcDir) {
  const file = typeof entry.f === "string" ? toSrcRel(entry.f, srcDir) : null;
  return { file, line: file ? safeLine(entry.l) : null };
}

// O payload vem da página (código do app + libs): trata como não confiável. Devolve só campos conhecidos,
// com arquivo validado contra <projeto>/src, ou null se não der para ancorar o clique em src/.
function sanitizeClick(payload, srcDir) {
  let raw;
  try {
    raw = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !raw.element || typeof raw.element !== "object") return null;
  if (!srcDir) return null;

  const { file, line } = resolveSource(raw.element, srcDir);
  if (!file) return null;

  const chain = [];
  for (const item of Array.isArray(raw.chain) ? raw.chain.slice(0, MAX_CHAIN) : []) {
    if (!item || typeof item !== "object") continue;
    const name = safeName(item.n);
    if (!name) continue;
    chain.push({ name, ...resolveSource(item, srcDir) });
  }

  return {
    name: safeName(raw.element.n) || "?",
    host: raw.element.host === true,
    inner: raw.element.inner === true,
    tag: typeof raw.tag === "string" && TAG.test(raw.tag) ? raw.tag : null,
    testId: sanitizeTestId(raw.testId),
    file,
    line,
    chain,
  };
}

module.exports = { CLICK_BINDING, CLICK_HOOK, sanitizeClick, sanitizeTestId };
