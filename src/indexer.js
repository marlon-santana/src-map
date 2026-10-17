"use strict";

const fs = require("fs");
const path = require("path");
const { createParseCache } = require("./parse");
const { createResolver } = require("./resolve");
const { extractRoutes } = require("./routes");

const JS_RE = /\.(js|jsx|ts|tsx)$/;
const SPEC_RE = /\.(spec|test)\.[jt]sx?$/;
const SHARED_TIERS = ["atoms", "molecules", "organisms", "templates"];
const LANE_ORDER = ["Admin", "Professor", "Student", "Shared", "PDF", "Outros", "Compartilhados"];
const MAX_DEPTH = 4;
const MAX_DEPS = 150;

const parseCache = createParseCache();

function scanFiles(srcDir) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else files.push(path.relative(srcDir, abs).split(path.sep).join("/"));
    }
  };
  visit(srcDir);
  return files;
}

function fileKind(rel) {
  if (SPEC_RE.test(rel)) return "spec";
  if (JS_RE.test(rel)) return "code";
  if (/\.(css|scss|less)$/.test(rel)) return "style";
  if (/\.md$/i.test(rel)) return "doc";
  return "other";
}

function depCategory(rel) {
  if (rel.startsWith("services/hooks/")) return "hooks";
  if (rel.startsWith("services/api/")) return "api";
  if (rel.startsWith("services/constants/")) return "constantes";
  if (rel.startsWith("services/helpers")) return "helpers";
  if (rel.startsWith("services/")) return "services";
  if (/^components\/(atoms|molecules|organisms|templates)\//.test(rel)) return "compartilhados";
  if (rel.startsWith("components/")) return "componentes";
  if (rel.startsWith("store/") || rel.startsWith("Context/")) return "estado";
  return "outros";
}

// Só seguimos adiante em camadas onde a falha costuma nascer (hook -> service -> http).
const EXPAND = new Set(["hooks", "api", "services", "componentes"]);

function laneFor(dirRel) {
  const parts = dirRel.split("/");
  if (parts[0] === "components" && parts[1] === "pages") {
    const role = parts[2] || "Outros";
    return parts.length >= 5 ? `${role} · ${parts[3]}` : role;
  }
  if (parts[0] === "components" && SHARED_TIERS.includes(parts[1])) return `Compartilhados · ${parts[1]}`;
  return "Outros";
}

function laneRole(lane) {
  return lane.split(" · ")[0];
}

function buildIndex(srcDir) {
  const started = Date.now();
  const allFiles = scanFiles(srcDir);
  const fileSet = new Set(allFiles);
  const runInfo = new Map(); // um stat por arquivo a cada indexação
  const getInfo = (rel) => {
    if (!JS_RE.test(rel)) return null;
    if (!runInfo.has(rel)) runInfo.set(rel, parseCache.get(path.join(srcDir, rel)));
    return runInfo.get(rel);
  };
  const resolver = createResolver(fileSet, getInfo);

  // ── 1. Raízes de rota ────────────────────────────────────────────────
  const routeEntries = extractRoutes({ srcDir, resolver, getInfo });
  const isComponentRoot = (file) => file.startsWith("components/") && !file.startsWith("components/templates/");
  const rootsByDir = new Map(); // dir -> { rootFiles:Set, routes:[] }
  const addRoot = (file, route) => {
    const dir = path.posix.dirname(file);
    if (!rootsByDir.has(dir)) rootsByDir.set(dir, { rootFiles: new Set(), routes: [] });
    const entry = rootsByDir.get(dir);
    entry.rootFiles.add(file);
    if (!entry.routes.some((r) => r.routePath === route.routePath && r.routeKey === route.routeKey && r.routeFile === route.routeFile)) {
      entry.routes.push({ routePath: route.routePath, routeKey: route.routeKey, routeFile: route.routeFile });
    }
  };
  for (const entry of routeEntries) {
    if (isComponentRoot(entry.componentFile)) {
      addRoot(entry.componentFile, entry);
    } else if (entry.componentFile.startsWith("routes/")) {
      // wrapper local (ex.: routes/Component/AlgumaEntry): usa o que ele renderiza
      const info = getInfo(entry.componentFile);
      if (!info) continue;
      for (const name of info.jsxNames) {
        const imp = info.imports[name];
        if (!imp) continue;
        const file = resolver.resolveImportBinding(entry.componentFile, imp);
        if (file && isComponentRoot(file)) addRoot(file, entry);
      }
    }
  }

  // ── 2. Cards ─────────────────────────────────────────────────────────
  const cards = [];
  const cardByDir = new Map();
  const makeCard = (dir, kind, extra) => {
    const lane = kind === "shared" ? laneFor(dir) : laneFor(dir);
    const card = {
      id: dir,
      name: path.posix.basename(dir),
      kind,
      lane,
      role: laneRole(lane),
      dir,
      routes: [],
      rootFile: null,
      ...extra,
    };
    cards.push(card);
    cardByDir.set(dir, card);
    return card;
  };

  for (const [dir, entry] of rootsByDir) {
    const rootFiles = [...entry.rootFiles];
    const preferred = rootFiles.find((f) => /\/index\.[jt]sx?$/.test(f)) || rootFiles[0];
    makeCard(dir, "route", { routes: entry.routes, rootFile: preferred });
  }

  // compartilhados: diretório mais alto, não-barrel, com index.* sob atoms/molecules/organisms/templates
  const dirsWithIndex = new Map(); // dir -> index file
  for (const file of allFiles) {
    if (/\/index\.[jt]sx?$/.test(file) && !SPEC_RE.test(file)) dirsWithIndex.set(path.posix.dirname(file), file);
  }
  for (const tier of SHARED_TIERS) {
    const tierDir = `components/${tier}`;
    const candidates = [...dirsWithIndex.keys()]
      .filter((d) => d.startsWith(`${tierDir}/`))
      .filter((d) => {
        const info = getInfo(dirsWithIndex.get(d));
        return info && !info.isBarrel;
      })
      .sort((a, b) => a.split("/").length - b.split("/").length);
    const taken = [];
    for (const dir of candidates) {
      if (taken.some((t) => dir.startsWith(`${t}/`))) continue;
      taken.push(dir);
      if (cardByDir.has(dir)) continue;
      makeCard(dir, "shared", { rootFile: dirsWithIndex.get(dir) });
    }
  }

  const cardDirs = new Set(cardByDir.keys());
  const cardOfFile = (rel) => {
    let dir = path.posix.dirname(rel);
    while (dir && dir !== ".") {
      if (cardDirs.has(dir)) return cardByDir.get(dir);
      dir = path.posix.dirname(dir);
    }
    return null;
  };

  // ── 3. Arestas de import (resolvidas através de barrels) ─────────────
  const edgeCache = new Map();
  const edgesOf = (rel) => {
    if (edgeCache.has(rel)) return edgeCache.get(rel);
    const out = new Set();
    const info = getInfo(rel);
    if (info) {
      const viaBinding = new Set();
      for (const imp of Object.values(info.imports)) {
        viaBinding.add(imp.source);
        const target = resolver.resolveImportBinding(rel, imp);
        if (target) out.add(target);
      }
      for (const source of info.sources) {
        if (viaBinding.has(source)) continue;
        const target = resolver.resolveModule(rel, source);
        if (target) out.add(target);
      }
    }
    out.delete(rel);
    const list = [...out];
    edgeCache.set(rel, list);
    return list;
  };

  // ── 4. Árvore de pasta + dependências por card ───────────────────────
  const filesByDir = new Map();
  for (const file of allFiles) {
    const dir = path.posix.dirname(file);
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir).push(file);
  }
  const subdirs = new Map();
  for (const dir of filesByDir.keys()) {
    let child = dir;
    while (child && child !== ".") {
      const parent = path.posix.dirname(child);
      if (!subdirs.has(parent)) subdirs.set(parent, new Set());
      subdirs.get(parent).add(child);
      child = parent;
    }
  }

  const buildTree = (dir, ownerDir, rootFile) => {
    const nodes = [];
    const files = (filesByDir.get(dir) || []).slice().sort();
    const fileNode = (file) => ({ type: "file", name: path.posix.basename(file), path: file, kind: fileKind(file), isRoot: file === rootFile });
    if (files.includes(rootFile)) nodes.push(fileNode(rootFile)); // arquivo principal sempre no topo
    const children = [...(subdirs.get(dir) || [])].sort();
    for (const child of children) {
      if (child === ownerDir) continue;
      const name = path.posix.basename(child);
      if (cardDirs.has(child) && child !== ownerDir) {
        nodes.push({ type: "card", name, path: child, cardId: child });
        continue;
      }
      nodes.push({ type: "dir", name, path: child, children: buildTree(child, ownerDir, rootFile) });
    }
    for (const file of files) {
      if (file !== rootFile) nodes.push(fileNode(file));
    }
    return nodes;
  };
  const countFiles = (nodes) => nodes.reduce((n, node) => n + (node.type === "file" ? 1 : node.type === "dir" ? countFiles(node.children) : 0), 0);

  const ownFilesOf = (card) => {
    const out = [];
    const visit = (dir) => {
      for (const f of filesByDir.get(dir) || []) out.push(f);
      for (const child of subdirs.get(dir) || []) {
        if (child !== card.dir && cardDirs.has(child)) continue;
        visit(child);
      }
    };
    visit(card.dir);
    return out;
  };

  const depsOf = (card) => {
    const own = new Set(ownFilesOf(card));
    const found = new Map(); // file -> { file, category, cardId, depth }
    let frontier = [...own].filter((f) => JS_RE.test(f) && !SPEC_RE.test(f));
    const visited = new Set(frontier);
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const file of frontier) {
        for (const target of edgesOf(file)) {
          if (own.has(target) || visited.has(target) || !JS_RE.test(target)) continue;
          visited.add(target);
          if (target.startsWith("services/api/http/")) continue; // infra: não é o culpado de nada
          const category = depCategory(target);
          const owner = cardOfFile(target);
          if (!found.has(target) && found.size < MAX_DEPS) {
            found.set(target, { file: target, category, cardId: owner ? owner.id : null, depth });
          }
          if (EXPAND.has(category) && !owner) next.push(target);
        }
      }
      frontier = next;
    }
    return [...found.values()].sort((a, b) => a.category.localeCompare(b.category) || a.depth - b.depth || a.file.localeCompare(b.file));
  };

  for (const card of cards) {
    card.tree = buildTree(card.dir, card.dir, card.rootFile);
    card.fileCount = countFiles(card.tree);
    card.deps = depsOf(card);
    card.hasSpec = ownFilesOf(card).some((f) => SPEC_RE.test(f));
  }

  const laneRank = (lane) => {
    const i = LANE_ORDER.indexOf(laneRole(lane));
    return i === -1 ? LANE_ORDER.length : i;
  };
  cards.sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || a.lane.localeCompare(b.lane) || a.name.localeCompare(b.name));

  return {
    version: 1,
    generatedAt: Date.now(),
    elapsedMs: Date.now() - started,
    cards,
    stats: {
      files: allFiles.length,
      routeEntries: routeEntries.length,
      routeCards: cards.filter((c) => c.kind === "route").length,
      sharedCards: cards.filter((c) => c.kind === "shared").length,
      unresolvedPaths: routeEntries.filter((e) => !e.routePath).length,
    },
    files: allFiles.filter((f) => JS_RE.test(f)),
  };
}

module.exports = { buildIndex };
