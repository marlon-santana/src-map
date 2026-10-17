"use strict";

// URL -> cards. Usa os routePath do índice (padrões como /admin/x/:id ou /app/*).
const REGEX_SPECIALS = new Set(".*+?^${}()|[]\\".split(""));
const escapeRegex = (text) => [...text].map((ch) => (REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch)).join("");

function compile(routePath) {
  const normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
  const segments = normalized.split("/").filter(Boolean);
  let params = 0;
  let wild = 0;
  let literals = 0;
  let body = "";
  for (const seg of segments) {
    if (seg === "*") {
      wild++;
      body += "(?:/.*)?"; // react-router: "/x/*" também casa "/x"
    } else if (seg.startsWith(":")) {
      params++;
      body += "/[^/]+";
    } else {
      literals++;
      body += `/${escapeRegex(seg)}`;
    }
  }
  return { pattern: normalized, regex: new RegExp(`^${body || "/"}/?$`), score: literals * 10 - params * 2 - wild * 5 };
}

function createRouteMatcher(cards) {
  const entries = [];
  for (const card of cards) {
    for (const route of card.routes) {
      if (!route.routePath) continue;
      entries.push({ cardId: card.id, ...compile(route.routePath) });
    }
  }
  return {
    // Retorna { pattern, cardIds } da rota mais específica, ou null.
    match(pathname) {
      const clean = pathname.split(/[?#]/)[0] || "/";
      let best = null;
      for (const entry of entries) {
        if (!entry.regex.test(clean)) continue;
        if (!best || entry.score > best.score) best = { score: entry.score, pattern: entry.pattern, cardIds: new Set([entry.cardId]) };
        else if (entry.score === best.score && entry.pattern === best.pattern) best.cardIds.add(entry.cardId);
      }
      return best ? { pattern: best.pattern, cardIds: [...best.cardIds] } : null;
    },
  };
}

module.exports = { createRouteMatcher };
