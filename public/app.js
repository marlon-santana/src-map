"use strict";

const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

const $ = (id) => document.getElementById(id);
const treeWrapEl = $("tree-wrap");
const canvasStageEl = $("canvas-stage");
const treeEl = $("tree");
const zoomResetEl = $("zoom-reset");
const searchEl = $("search");
const roleTabsEl = $("role-tabs");
const hideSharedEl = $("hide-shared");
const showRoutesEl = $("show-routes");
const overlayEl = $("overlay");
const detailsBodyEl = $("details-body");
const followRouteEl = $("follow-route");
const showPathEl = $("show-path");
const trailEl = $("trail");
const errorsWrapEl = $("errors-wrap");

const ROLE_ALL = "Todos";
const DEP_ORDER = ["hooks", "api", "services", "constantes", "helpers", "componentes", "compartilhados", "estado", "outros"];
const MAX_FILE_HITS = 400;

let index = null;
let cardsById = new Map();
let fileCards = new Map(); // arquivo -> cards que o contêm ou importam
let role = ROLE_ALL;
let query = "";
let zoomScale = 1;
let panPointer = null;
let currentCard = null;
let mode = "map";
let rt = { status: "disconnected", tabs: 0, message: "" };
let trail = [];
let currentIds = new Set();
let mountedIds = new Set();
let mountedInfo = { hasDebugSource: null, fibers: 0 };
let errors = []; // mais recente primeiro; só metadados (sem mensagem de erro)
let cardErr = new Map(); // cardId -> { strong: [erro], weak: [erro] }
const MAX_WEAK_CARDS = 25;
const INFRA_PREFIXES = ["services/api/http/"];
const laneState = {}; // lane -> true (colapsada) | false (aberta); ausente = padrão

function loadSaved() {
  try {
    return (vscodeApi && vscodeApi.getState()) || JSON.parse(localStorage.getItem("src-map:ui") || "{}");
  } catch {
    return {};
  }
}

function save() {
  const state = { role, hideShared: hideSharedEl.checked, showRoutes: showRoutesEl.checked, followRoute: followRouteEl.checked, showPath: showPathEl.checked, zoomScale, laneState };
  try {
    if (vscodeApi) vscodeApi.setState(state);
    else localStorage.setItem("src-map:ui", JSON.stringify(state));
  } catch {
    // o painel segue funcional sem persistência de UI
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function send(message) {
  if (vscodeApi) vscodeApi.postMessage(message);
}

function openFile(file) {
  send({ type: "open", file });
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/* ── Zoom e pan (mesmo comportamento do cc-activity-map) ───────────── */

function layoutStage() {
  const padding = Number.parseFloat(getComputedStyle(treeWrapEl).paddingLeft) || 0;
  const available = Math.max(320, treeWrapEl.clientWidth - padding * 2);
  treeEl.style.width = `${available / zoomScale}px`;
  treeEl.style.transform = `scale(${zoomScale})`;
  canvasStageEl.style.width = `${available}px`;
  for (const box of treeEl.querySelectorAll(".file-hits-scroll")) {
    box.style.maxHeight = `${Math.max(160, (treeWrapEl.clientHeight * 0.7) / zoomScale)}px`;
  }
  canvasStageEl.style.height = `${treeEl.offsetHeight * zoomScale}px`;
  zoomResetEl.textContent = `${Math.round(zoomScale * 100)}%`;
}

function applyZoom(nextScale, anchor = null) {
  const previousScale = zoomScale;
  zoomScale = Math.max(0.4, Math.min(2, nextScale));
  const rect = treeWrapEl.getBoundingClientRect();
  const anchorX = anchor?.x ?? rect.width / 2;
  const anchorY = anchor?.y ?? rect.height / 2;
  const padding = Number.parseFloat(getComputedStyle(treeWrapEl).paddingLeft) || 0;
  const worldX = (treeWrapEl.scrollLeft + anchorX - padding) / previousScale;
  const worldY = (treeWrapEl.scrollTop + anchorY - padding) / previousScale;
  layoutStage();
  treeWrapEl.scrollLeft = Math.max(0, worldX * zoomScale - anchorX + padding);
  treeWrapEl.scrollTop = Math.max(0, worldY * zoomScale - anchorY + padding);
  save();
}

zoomResetEl.addEventListener("click", () => applyZoom(1));

treeWrapEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 1) return;
  if (event.button === 0 && event.target.closest(".node, .canvas-controls, .lane-label, .file-hits-scroll")) return;
  panPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: treeWrapEl.scrollLeft, top: treeWrapEl.scrollTop };
  treeWrapEl.classList.add("panning");
  treeWrapEl.setPointerCapture(event.pointerId);
});

treeWrapEl.addEventListener("pointermove", (event) => {
  if (!panPointer || event.pointerId !== panPointer.id) return;
  treeWrapEl.scrollLeft = panPointer.left - (event.clientX - panPointer.x);
  treeWrapEl.scrollTop = panPointer.top - (event.clientY - panPointer.y);
});

function stopPanning(event) {
  if (!panPointer || (event && event.pointerId !== panPointer.id)) return;
  if (treeWrapEl.hasPointerCapture(panPointer.id)) treeWrapEl.releasePointerCapture(panPointer.id);
  panPointer = null;
  treeWrapEl.classList.remove("panning");
}

treeWrapEl.addEventListener("pointerup", stopPanning);
treeWrapEl.addEventListener("pointercancel", stopPanning);
treeWrapEl.addEventListener(
  "wheel",
  (event) => {
    if (event.target.closest(".file-hits-scroll")) return; // rola só a lista de resultados
    event.preventDefault();
    const rect = treeWrapEl.getBoundingClientRect();
    applyZoom(zoomScale * Math.exp(-event.deltaY * 0.001), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  },
  { passive: false }
);

window.addEventListener("resize", layoutStage);

/* ── Índice e filtros ──────────────────────────────────────────────── */

function collectNames(nodes, out) {
  for (const node of nodes) {
    out.push(node.name);
    if (node.type === "dir") collectNames(node.children, out);
  }
  return out;
}

function prepare(payload) {
  index = payload;
  cardsById = new Map();
  for (const card of index.cards) {
    cardsById.set(card.id, card);
    const names = collectNames(card.tree, []);
    const routes = card.routes.map((r) => `${r.routePath || ""} ${r.routeKey || ""}`);
    card._hay = [card.name, card.dir, ...routes, ...names].join(" ").toLowerCase();
  }
  index.filesLower = index.files.map((f) => f.toLowerCase());
  fileCards = new Map();
  const add = (file, id) => {
    if (!fileCards.has(file)) fileCards.set(file, new Set());
    fileCards.get(file).add(id);
  };
  const walkTree = (nodes, id) => {
    for (const node of nodes) {
      if (node.type === "file") add(node.path, id);
      else if (node.type === "dir") walkTree(node.children, id);
    }
  };
  for (const card of index.cards) {
    walkTree(card.tree, card.id);
    for (const dep of card.deps) add(dep.file, card.id);
  }
  rebuildErrorIndex();
}

function renderRoleTabs() {
  roleTabsEl.textContent = "";
  const roles = [ROLE_ALL, ...new Set((index?.cards || []).map((c) => c.role))];
  if (!roles.includes(role)) role = ROLE_ALL;
  for (const name of roles) {
    const button = el("button", `view-tab${name === role ? " active" : ""}`, name);
    button.addEventListener("click", () => {
      role = name;
      save();
      renderRoleTabs();
      render();
    });
    roleTabsEl.appendChild(button);
  }
}

function matchingCards() {
  const q = query.trim().toLowerCase();
  return index.cards.filter((card) => {
    if (hideSharedEl.checked && card.kind === "shared") return false;
    if (role !== ROLE_ALL && card.role !== role) return false;
    return !q || card._hay.includes(q);
  });
}

function isLaneCollapsed(lane, searching) {
  if (searching) return false;
  if (lane in laneState) return laneState[lane];
  return lane.startsWith("Compartilhados");
}

function renderCard(card) {
  const node = el("div", "node");
  node.dataset.cardId = card.id;
  const row = el("div", "title-row");
  row.appendChild(el("span", "dot"));
  row.appendChild(el("span", "title", card.name));
  const openBtn = el("button", "open-btn", "↗");
  openBtn.title = "Abrir o componente no editor";
  openBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (card.rootFile) openFile(card.rootFile);
  });
  row.appendChild(openBtn);
  node.appendChild(row);

  if (showRoutesEl.checked && card.routes.length) {
    const first = card.routes[0];
    const label = first.routePath || (first.routeKey ? `ROUTE.${first.routeKey}` : "(rota)");
    const more = card.routes.length > 1 ? `  +${card.routes.length - 1}` : "";
    node.appendChild(el("div", "meta route", label + more));
  } else if (card.kind === "shared") {
    node.appendChild(el("div", "meta", card.dir.replace(/^components\//, "")));
  } else {
    node.appendChild(el("div", "meta", `${card.fileCount} arquivos`));
  }
  node.title = `${card.dir}\n${card.fileCount} arquivos · ${card.deps.length} dependências`;
  node.addEventListener("click", () => openCard(card.id));
  return node;
}

function renderLane(lane, cards, searching) {
  const collapsed = isLaneCollapsed(lane, searching);
  const box = el("section", `lane${lane.startsWith("Compartilhados") ? " shared" : ""}${collapsed ? " collapsed" : ""}`);
  const label = el("div", "lane-label", `${collapsed ? "▸" : "▾"} ${lane} · ${cards.length}`);
  label.addEventListener("click", () => {
    laneState[lane] = !isLaneCollapsed(lane, false);
    save();
    render();
  });
  box.appendChild(label);
  const grid = el("div", "lane-cards");
  for (const card of cards) grid.appendChild(renderCard(card));
  box.appendChild(grid);
  return box;
}

function renderFileHits() {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  const hits = [];
  let total = 0;
  for (let i = 0; i < index.files.length; i++) {
    if (!index.filesLower[i].includes(q)) continue;
    total++;
    if (hits.length < MAX_FILE_HITS) hits.push(index.files[i]);
  }
  if (!total) return null;
  const box = el("section", "lane shared");
  box.appendChild(el("div", "lane-label", `Arquivos · ${total}${total > hits.length ? ` (mostrando ${hits.length})` : ""}`));
  const list = el("div", "file-hits-scroll");
  for (const file of hits) {
    const row = el("div", "file-hit");
    row.dataset.file = file;
    row.appendChild(el("span", "base", baseName(file)));
    row.appendChild(el("span", "dir", dirName(file)));
    row.addEventListener("click", () => openFile(file));
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

function render() {
  treeEl.textContent = "";
  if (!index) {
    treeEl.appendChild(el("div", "empty", "Indexando o proz-frontend…"));
    layoutStage();
    return;
  }
  const searching = Boolean(query.trim());
  const cards = matchingCards();
  $("subtitle").textContent = `${cards.length} de ${index.cards.length} cards · clique para ver os arquivos`;

  const lanes = new Map();
  for (const card of cards) {
    if (!lanes.has(card.lane)) lanes.set(card.lane, []);
    lanes.get(card.lane).push(card);
  }
  for (const [lane, list] of lanes) treeEl.appendChild(renderLane(lane, list, searching));
  const hits = renderFileHits();
  if (hits) treeEl.appendChild(hits);
  if (!lanes.size && !hits) treeEl.appendChild(el("div", "empty", "Nenhum card ou arquivo encontrado para esse filtro."));
  layoutStage();
  applyRuntimeClasses();
}

/* ── Overlay: árvore de arquivos + dependências ────────────────────── */

const KIND_TAG = { code: "JS", spec: "T", style: "CSS", doc: "MD", other: "·" };

function renderTree(nodes, depth, card) {
  const ul = el("ul", depth === 0 ? "ftree" : "");
  for (const node of nodes) {
    const li = el("li");
    if (node.type === "dir") {
      const open = depth < 1 || card.fileCount <= 40;
      const row = el("div", "frow dir");
      row.appendChild(el("span", "tag", open ? "▾" : "▸"));
      row.appendChild(el("span", "name", node.name));
      const child = renderTree(node.children, depth + 1, card);
      child.classList.toggle("hidden", !open);
      row.addEventListener("click", () => {
        const hidden = child.classList.toggle("hidden");
        row.firstChild.textContent = hidden ? "▸" : "▾";
      });
      li.appendChild(row);
      li.appendChild(child);
    } else if (node.type === "card") {
      const row = el("div", "frow");
      row.appendChild(el("span", "tag", "↳"));
      row.appendChild(el("span", "name link-card", `${node.name} (outro card)`));
      row.addEventListener("click", () => openCard(node.cardId));
      li.appendChild(row);
    } else {
      const row = el("div", `frow file ${node.kind}`);
      row.dataset.file = node.path;
      row.appendChild(el("span", `tag ${node.kind}`, KIND_TAG[node.kind] || "·"));
      row.appendChild(el("span", "name", node.name));
      if (node.isRoot) row.appendChild(el("span", "root-mark", "● principal"));
      row.addEventListener("click", () => openFile(node.path));
      li.appendChild(row);
    }
    ul.appendChild(li);
  }
  return ul;
}

function renderDeps(card) {
  const frag = document.createDocumentFragment();
  const groups = new Map();
  for (const dep of card.deps) {
    if (!groups.has(dep.category)) groups.set(dep.category, []);
    groups.get(dep.category).push(dep);
  }
  const names = [...groups.keys()].sort((a, b) => DEP_ORDER.indexOf(a) - DEP_ORDER.indexOf(b));
  for (const name of names) {
    const list = groups.get(name);
    frag.appendChild(el("div", "section-title", `Dependências · ${name} (${list.length})`));
    for (const dep of list) {
      const row = el("div", "dep-row");
      row.dataset.file = dep.file;
      row.appendChild(el("span", "base", baseName(dep.file)));
      row.appendChild(el("span", "dir", dirName(dep.file)));
      if (dep.depth > 1) row.appendChild(el("span", "depth", `via ${dep.depth - 1}`));
      if (dep.cardId && cardsById.has(dep.cardId)) {
        const badge = el("span", "card-badge", cardsById.get(dep.cardId).name);
        badge.title = "Abrir o card dono deste arquivo";
        badge.addEventListener("click", (event) => {
          event.stopPropagation();
          openCard(dep.cardId);
        });
        row.appendChild(badge);
      }
      row.addEventListener("click", () => openFile(dep.file));
      frag.appendChild(row);
    }
  }
  if (!names.length) frag.appendChild(el("div", "empty", "Nenhuma dependência resolvida dentro de src/."));
  return frag;
}

function openCard(id) {
  const card = cardsById.get(id);
  if (!card) return;
  currentCard = card;
  $("details-title").textContent = card.name;
  $("details-kind").textContent = card.kind === "route" ? "rota" : "compartilhado";
  $("details-path").textContent = `src/${card.dir} · ${card.fileCount} arquivos`;
  $("open-root").disabled = !card.rootFile;
  detailsBodyEl.textContent = "";
  const cardErrors = errorsOf(card.id);
  if (cardErrors.length) detailsBodyEl.appendChild(renderErrorBlock(card, cardErrors));

  if (card.routes.length) {
    detailsBodyEl.appendChild(el("div", "section-title", `Rotas (${card.routes.length})`));
    for (const route of card.routes) {
      const row = el("div", "route-row");
      row.appendChild(el("span", "rpath", route.routePath || (route.routeKey ? `ROUTE.${route.routeKey}` : "(rota)")));
      row.appendChild(el("span", "rfile", route.routeFile));
      row.title = "Abrir onde a rota é declarada";
      row.addEventListener("click", () => openFile(route.routeFile));
      detailsBodyEl.appendChild(row);
    }
  }
  detailsBodyEl.appendChild(el("div", "section-title", "Arquivos da pasta"));
  detailsBodyEl.appendChild(renderTree(card.tree, 0, card));
  detailsBodyEl.appendChild(renderDeps(card));
  markErrorFiles(cardErrors);
  overlayEl.classList.remove("hidden");
  detailsBodyEl.parentElement.scrollTop = 0;
}

function closeCard() {
  overlayEl.classList.add("hidden");
  currentCard = null;
}

$("details-close").addEventListener("click", closeCard);
overlayEl.addEventListener("click", (event) => {
  if (event.target === overlayEl) closeCard();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlayEl.classList.contains("hidden")) closeCard();
});
$("open-root").addEventListener("click", () => currentCard?.rootFile && openFile(currentCard.rootFile));
$("reveal-dir").addEventListener("click", () => currentCard && send({ type: "reveal", file: currentCard.dir }));

/* ── Runtime: rota atual, erros e destaques (fases 2 e 3) ───────────── */

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (at) => {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const isInfra = (file) => INFRA_PREFIXES.some((prefix) => file.startsWith(prefix));
const cardName = (id) => (cardsById.get(id) ? cardsById.get(id).name : id);

function errorWhere(error) {
  const c = error.culprit;
  if (!c) return "frame não resolvido (erro dentro de lib ou sourcemap indisponível)";
  return `${c.fn ? c.fn + " · " : ""}${baseName(c.file)}:${c.line}`;
}

function errorTitle(error) {
  return error.http ? `${error.http.method} ${error.http.endpoint} → ${error.errorClass}` : error.errorClass;
}

// forte: card ativo da rota no momento do erro. fraco: demais cards que contêm/importam o arquivo quebrado.
function rebuildErrorIndex() {
  cardErr = new Map();
  const slot = (id) => {
    if (!cardErr.has(id)) cardErr.set(id, { strong: [], weak: [] });
    return cardErr.get(id);
  };
  for (const error of errors) {
    const strong = new Set(error.cardIds || []);
    for (const id of strong) slot(id).strong.push(error);
    const file = error.culprit && error.culprit.file;
    if (!file || isInfra(file)) continue; // infra é importada por todo mundo: acenderia o mapa inteiro
    const owners = [...(fileCards.get(file) || [])].filter((id) => !strong.has(id));
    if (owners.length > MAX_WEAK_CARDS) continue;
    for (const id of owners) slot(id).weak.push(error);
  }
  const tab = $("errors-tab");
  if (tab) tab.textContent = errors.length ? `Erros (${errors.length})` : "Erros";
}

function errorsOf(cardId) {
  const entry = cardErr.get(cardId);
  if (!entry) return [];
  return [...entry.strong.map((e) => ({ error: e, weak: false })), ...entry.weak.map((e) => ({ error: e, weak: true }))];
}

function applyRuntimeClasses() {
  const rank = new Map();
  trail.forEach((entry, i) => {
    const recency = trail.length > 1 ? i / (trail.length - 1) : 1;
    for (const id of entry.cardIds) rank.set(id, recency);
  });
  for (const node of treeEl.querySelectorAll(".node[data-card-id]")) {
    const id = node.dataset.cardId;
    const entry = cardErr.get(id);
    const strong = Boolean(entry && entry.strong.length);
    const weak = Boolean(entry && entry.weak.length && !strong);
    node.classList.toggle("in-use", currentIds.has(id));
    node.classList.toggle("mounted", mountedIds.has(id) && !currentIds.has(id));
    node.classList.toggle("visited", rank.has(id) && !currentIds.has(id));
    if (rank.has(id)) node.style.setProperty("--recency", String(rank.get(id)));
    else node.style.removeProperty("--recency");
    node.classList.toggle("error", strong);
    node.classList.toggle("error-weak", weak);
    const dot = node.querySelector(".dot");
    if (dot) {
      dot.classList.toggle("error", strong);
      dot.classList.toggle("running", !strong && currentIds.has(id));
    }
    for (const stale of node.querySelectorAll(".meta.error-line, .meta.weak-line")) stale.remove();
    if (strong) node.appendChild(el("div", "meta error-line", `${entry.strong[0].errorClass} · ${errorWhere(entry.strong[0])}`));
    else if (weak) node.appendChild(el("div", "meta weak-line", `importa ${baseName(entry.weak[0].culprit.file)} (erro)`));
  }
  renderTrail();
  if (mode === "errors") renderErrorsView();
}

function focusCard(id) {
  const card = cardsById.get(id);
  if (!card) return;
  if (mode !== "map") setMode("map");
  if (isLaneCollapsed(card.lane, Boolean(query.trim()))) {
    laneState[card.lane] = false;
    render();
  }
  const node = treeEl.querySelector(`.node[data-card-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

function renderTrail() {
  trailEl.textContent = "";
  trailEl.classList.toggle("hidden", !trail.length);
  trail.forEach((entry, i) => {
    if (i) trailEl.appendChild(el("span", "trail-sep", "›"));
    const chip = el("div", "trail-chip");
    chip.style.setProperty("--recency", String(trail.length > 1 ? i / (trail.length - 1) : 1));
    if (i === trail.length - 1) chip.classList.add("current");
    chip.appendChild(el("span", "tpath", entry.pattern));
    const name = entry.cardIds.length ? entry.cardIds.map(cardName).join(", ") : "sem card";
    chip.appendChild(el("span", "tcard", name));
    chip.title = `${clock(entry.at)} — clique para ir ao card`;
    chip.addEventListener("click", () => entry.cardIds[0] && focusCard(entry.cardIds[0]));
    trailEl.appendChild(chip);
  });
  trailEl.scrollLeft = trailEl.scrollWidth;
}

function renderErrorsView() {
  errorsWrapEl.textContent = "";
  if (!errors.length) {
    errorsWrapEl.appendChild(el("div", "err-empty", "Nenhum erro capturado. Conecte o Chrome (Iniciar ou Anexar) e use o app: exceções, erros de render e respostas HTTP 4xx/5xx aparecem aqui."));
    return;
  }
  for (const error of errors) {
    const item = el("div", "err-item");
    item.dataset.errorId = String(error.id);
    item.appendChild(el("span", "err-time", clock(error.at)));
    item.appendChild(el("span", "err-class", errorTitle(error)));
    const where = el("span", "err-where");
    if (error.culprit) {
      if (error.culprit.fn) where.appendChild(el("span", "fn", `${error.culprit.fn}  `));
      where.appendChild(el("span", "loc", `${error.culprit.file}:${error.culprit.line}`));
    } else {
      where.textContent = errorWhere(error);
    }
    item.appendChild(where);
    const meta = el("span", "err-meta");
    meta.appendChild(el("span", "err-kind", error.kind));
    if (error.route) meta.appendChild(el("span", "", error.route));
    const cardId = (error.cardIds || [])[0];
    if (cardId) {
      const btn = el("button", "err-card-btn", cardName(cardId));
      btn.title = "Abrir o card com os arquivos";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        openCard(cardId);
      });
      meta.appendChild(btn);
    }
    item.appendChild(meta);
    item.title = error.culprit ? "Abrir o arquivo culpado na linha do erro" : "Frame não resolvido";
    item.addEventListener("click", () => error.culprit && send({ type: "open", file: error.culprit.file, line: error.culprit.line }));
    errorsWrapEl.appendChild(item);
  }
}

function renderErrorBlock(card, entries) {
  const block = el("div", "");
  block.appendChild(el("div", "section-title", `Erros neste card (${entries.length})`));
  for (const { error, weak } of entries) {
    const box = el("div", "err-block");
    const head = el("div", "err-head");
    head.appendChild(el("span", "err-class", errorTitle(error)));
    head.appendChild(el("span", "err-kind", error.kind));
    head.appendChild(el("span", "err-time", clock(error.at)));
    if (error.route) head.appendChild(el("span", "weak-note", error.route));
    box.appendChild(head);
    if (weak) box.appendChild(el("div", "weak-note", "Este card só importa o arquivo que quebrou; o erro ocorreu em outra tela."));
    if (error.culprit) {
      const row = el("div", "frow file error");
      row.dataset.file = error.culprit.file;
      row.appendChild(el("span", "tag code", "JS"));
      row.appendChild(el("span", "name", `${error.culprit.file}:${error.culprit.line}${error.culprit.fn ? "  ·  " + error.culprit.fn : ""}`));
      row.title = "Abrir o arquivo culpado na linha do erro";
      row.addEventListener("click", () => send({ type: "open", file: error.culprit.file, line: error.culprit.line }));
      box.appendChild(row);
    } else {
      box.appendChild(el("div", "weak-note", "Frame não resolvido: o erro nasceu dentro de uma lib ou o sourcemap não estava disponível."));
    }
    if (showPathEl.checked) {
      for (const frame of error.path || []) {
        const row = el("div", "frow file path-hint");
        row.dataset.file = frame.file;
        row.appendChild(el("span", "tag", "↳"));
        row.appendChild(el("span", "name", `${frame.file}:${frame.line}${frame.fn ? "  ·  " + frame.fn : ""}`));
        row.title = "No caminho de chamada";
        row.addEventListener("click", () => send({ type: "open", file: frame.file, line: frame.line }));
        box.appendChild(row);
      }
    }
    block.appendChild(box);
  }
  const clear = el("button", "err-clear-card", "Limpar erros deste card");
  clear.addEventListener("click", () => {
    removeErrors(entries.map((e) => e.error.id));
    openCard(card.id);
  });
  block.appendChild(clear);
  return block;
}

// Borda vermelha no arquivo culpado e laranja nos do caminho, dentro da árvore e das dependências.
function markErrorFiles(entries) {
  const culprits = new Set();
  const paths = new Set();
  for (const { error } of entries) {
    if (error.culprit) culprits.add(error.culprit.file);
    if (showPathEl.checked) for (const f of error.path || []) paths.add(f.file);
  }
  for (const row of detailsBodyEl.querySelectorAll(".ftree [data-file], .dep-row[data-file]")) {
    const file = row.dataset.file;
    if (culprits.has(file)) row.classList.add("error");
    else if (paths.has(file)) row.classList.add("path-hint");
  }
}

function removeErrors(ids) {
  const drop = new Set(ids);
  errors = errors.filter((e) => !drop.has(e.id));
  send({ type: "clearErrors", ids });
  rebuildErrorIndex();
  applyRuntimeClasses();
}

function setMode(next) {
  mode = next;
  for (const tab of $("mode-tabs").querySelectorAll(".view-tab")) tab.classList.toggle("active", tab.dataset.mode === mode);
  treeWrapEl.classList.toggle("hidden", mode !== "map");
  errorsWrapEl.classList.toggle("hidden", mode !== "errors");
  roleTabsEl.classList.toggle("hidden", mode !== "map");
  if (mode === "errors") renderErrorsView();
  else layoutStage();
}

function setRtStatus(status) {
  rt = status;
  const labels = {
    disconnected: "Chrome desconectado",
    starting: "Chrome iniciando…",
    waiting: "Chrome conectado · aguardando aba",
    connected: `Chrome conectado · ${status.tabs} aba${status.tabs === 1 ? "" : "s"}`,
  };
  $("rt-status-text").textContent = labels[status.status] || status.status;
  $("rt-status").className = `status${status.status === "connected" ? " live" : status.status === "starting" || status.status === "waiting" ? " starting" : ""}`;
  $("rt-status").title = status.message || "Conexão com o Chrome (CDP)";
  const active = status.status !== "disconnected";
  $("launch-btn").classList.toggle("hidden", active);
  $("attach-btn").classList.toggle("hidden", active);
  $("disconnect-btn").classList.toggle("hidden", !active);
  if (!active) {
    currentIds = new Set();
    mountedIds = new Set();
  }
  applyRuntimeClasses();
}

function onRoute(route, nextTrail) {
  trail = nextTrail || trail;
  currentIds = new Set(route.cardIds);
  applyRuntimeClasses();
  if (followRouteEl.checked && route.cardIds[0]) focusCard(route.cardIds[0]);
}

function addError(error) {
  errors.unshift(error);
  if (errors.length > 50) errors.length = 50;
  rebuildErrorIndex();
  applyRuntimeClasses();
  if (currentCard) openCard(currentCard.id);
}

/* ── Controles do cabeçalho e mensagens da extensão ────────────────── */

let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = searchEl.value;
    render();
  }, 120);
});
hideSharedEl.addEventListener("change", () => {
  save();
  render();
});
showRoutesEl.addEventListener("change", () => {
  save();
  render();
});
$("mode-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".view-tab");
  if (tab) setMode(tab.dataset.mode);
});
followRouteEl.addEventListener("change", save);
showPathEl.addEventListener("change", () => {
  save();
  if (currentCard) openCard(currentCard.id);
});
$("launch-btn").addEventListener("click", () => {
  setRtStatus({ status: "starting", tabs: 0, message: "iniciando…" });
  send({ type: "launch" });
});
$("attach-btn").addEventListener("click", () => {
  setRtStatus({ status: "starting", tabs: 0, message: "conectando…" });
  send({ type: "attach" });
});
$("disconnect-btn").addEventListener("click", () => send({ type: "disconnect" }));
$("clear-errors-btn").addEventListener("click", () => {
  errors = [];
  send({ type: "clearErrors" });
  rebuildErrorIndex();
  applyRuntimeClasses();
  if (currentCard) openCard(currentCard.id);
});
$("reindex-btn").addEventListener("click", () => {
  setStatus("indexando...", "");
  send({ type: "reindex" });
});

function setStatus(text, mode) {
  $("status-text").textContent = text;
  $("status").className = `status${mode ? ` ${mode}` : ""}`;
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "indexing") {
    setStatus("indexando...", "");
  } else if (message.type === "index") {
    prepare(message.payload);
    renderRoleTabs();
    render();
    const s = index.stats;
    setStatus(`índice pronto · ${index.elapsedMs}ms`, "live");
    $("status").title = `${s.files} arquivos · ${s.routeEntries} entradas de rota (${s.unresolvedPaths} sem path resolvido)`;
    if (currentCard && cardsById.has(currentCard.id)) openCard(currentCard.id);
  } else if (message.type === "failed") {
    setStatus(message.message || "falha ao indexar", "error");
  } else if (message.type === "runtime") {
    setRtStatus(message.status);
  } else if (message.type === "route") {
    onRoute(message.route, message.trail);
  } else if (message.type === "mounted") {
    mountedIds = new Set(message.mounted);
    mountedInfo = message.mountedInfo || mountedInfo;
    $("rt-status").title =
      mountedInfo.hasDebugSource === false ? "React sem _debugSource: só a rota está sendo mapeada" : `${mountedIds.size} cards com componentes montados`;
    applyRuntimeClasses();
  } else if (message.type === "runtimeError") {
    addError(message.error);
  } else if (message.type === "runtimeSnapshot") {
    trail = message.trail || [];
    currentIds = new Set(message.current || []);
    mountedIds = new Set(message.mounted || []);
    errors = message.errors || [];
    rebuildErrorIndex();
    setRtStatus(message.status || rt);
  }
});

const saved = loadSaved();
if (saved.role) role = saved.role;
if (typeof saved.hideShared === "boolean") hideSharedEl.checked = saved.hideShared;
if (typeof saved.showRoutes === "boolean") showRoutesEl.checked = saved.showRoutes;
if (typeof saved.followRoute === "boolean") followRouteEl.checked = saved.followRoute;
if (typeof saved.showPath === "boolean") showPathEl.checked = saved.showPath;
if (typeof saved.zoomScale === "number") zoomScale = Math.max(0.4, Math.min(2, saved.zoomScale));
Object.assign(laneState, saved.laneState || {});

render();
send({ type: "ready" });
