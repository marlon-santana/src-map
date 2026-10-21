"use strict";

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const vscode = require("vscode");
const { RuntimeMonitor, probeUrl } = require("./src/runtime");
const { createRouteMatcher } = require("./src/routematch");
const { sanitizePath } = require("./src/stack");

const VIEW_TYPE = "srcMap.dashboard";

let panel = null;
let worker = null;
let requestId = 0;
let lastIndex = null;
let watcher = null;
let watchTimer = null;

// Runtime (fases 2 e 3): tudo em memória. Nada vai para disco.
const MAX_ERRORS = 50;
const MAX_TRAIL = 10;
const MAX_CLICKS = 10;
let monitor = null;
let monitorContext = null;
let matcher = null;
let dirToCard = new Map();
let rtStatus = { status: "disconnected", tabs: 0, message: "" };
let trail = [];
let errors = [];
let errorSeq = 0;
let clicks = [];
let clickSeq = 0;
const currentByTab = new Map(); // tabId -> { pattern, cardIds }
const mountedByTab = new Map(); // tabId -> Set(cardId)
let mountedInfo = { hasDebugSource: null, fibers: 0 };

function hasProjectLayout(dir) {
  return fs.existsSync(path.join(dir, "src", "components", "pages")) && fs.existsSync(path.join(dir, "package.json"));
}

function detectProjectRoot() {
  const configured = vscode.workspace.getConfiguration("srcMap").get("projectRoot");
  if (configured && hasProjectLayout(configured)) return configured;
  if (process.env.SRC_MAP_PROJECT_ROOT && hasProjectLayout(process.env.SRC_MAP_PROJECT_ROOT)) return process.env.SRC_MAP_PROJECT_ROOT;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (hasProjectLayout(folder.uri.fsPath)) return folder.uri.fsPath;
  }
  return null;
}

function getWorker(context) {
  if (worker) return worker;
  worker = new Worker(path.join(context.extensionPath, "src", "worker.js"));
  worker.on("error", (error) => {
    console.error(`[src-map] ${error.message}`);
    worker = null;
  });
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
}

function runIndex(context, srcDir) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const w = getWorker(context);
    const onMessage = (message) => {
      if (message.id !== id) return;
      w.off("message", onMessage);
      w.off("error", onError);
      if (message.type === "index") resolve(message.index);
      else reject(new Error(message.message || "falha ao indexar"));
    };
    const onError = (error) => {
      w.off("message", onMessage);
      reject(error);
    };
    w.on("message", onMessage);
    w.once("error", onError);
    w.postMessage({ type: "index", id, srcDir });
  });
}

async function reindex(context) {
  const root = detectProjectRoot();
  if (!root) {
    panel?.webview.postMessage({
      type: "failed",
      message: "proz-frontend não encontrado: abra a pasta no VS Code ou defina srcMap.projectRoot",
    });
    return;
  }
  panel?.webview.postMessage({ type: "indexing" });
  try {
    lastIndex = { root, ...(await runIndex(context, path.join(root, "src"))) };
    rebuildLookups();
    panel?.webview.postMessage({ type: "index", payload: lastIndex });
    watchSources(context, root);
  } catch (error) {
    panel?.webview.postMessage({ type: "failed", message: `falha ao indexar: ${error.message}` });
  }
}

function watchSources(context, root) {
  if (watcher) return;
  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(root, "src"), "**/*"));
  const schedule = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (panel) reindex(context);
    }, 1500);
  };
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  watcher.onDidChange(schedule);
  context.subscriptions.push(watcher);
}

// Só abre arquivos dentro de <root>/src: a mensagem vem do webview.
function resolveInsideSrc(rel) {
  if (!lastIndex || typeof rel !== "string") return null;
  const srcDir = path.join(lastIndex.root, "src");
  const abs = path.resolve(srcDir, rel);
  if (abs !== srcDir && !abs.startsWith(srcDir + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

async function openFile(rel, line) {
  const abs = resolveInsideSrc(rel);
  if (!abs) {
    vscode.window.showWarningMessage(`src-map: arquivo não encontrado (${rel}).`);
    return;
  }
  const uri = vscode.Uri.file(abs);
  const column = vscode.window.visibleTextEditors.find((e) => e.viewColumn)?.viewColumn ?? vscode.ViewColumn.One;
  const options = { preview: false, viewColumn: column };
  if (Number.isInteger(line) && line > 0) {
    const pos = new vscode.Position(line - 1, 0);
    options.selection = new vscode.Range(pos, pos);
  }
  await vscode.window.showTextDocument(uri, options);
}

/* ── Runtime: rota atual, componentes montados e erros (fases 2 e 3) ───────── */

function post(message) {
  panel?.webview.postMessage(message);
}

function rebuildLookups() {
  matcher = createRouteMatcher(lastIndex.cards);
  dirToCard = new Map(lastIndex.cards.map((card) => [card.dir, card.id]));
}

function cardIdOfFile(rel) {
  let dir = path.posix.dirname(rel);
  while (dir && dir !== ".") {
    if (dirToCard.has(dir)) return dirToCard.get(dir);
    dir = path.posix.dirname(dir);
  }
  return null;
}

const unionOf = (map) => [...new Set([...map.values()].flatMap((v) => (v instanceof Set ? [...v] : v.cardIds)))];

function runtimeSnapshot() {
  return {
    type: "runtimeSnapshot",
    status: rtStatus,
    trail,
    current: unionOf(currentByTab),
    mounted: unionOf(mountedByTab),
    mountedInfo,
    errors,
    clicks,
  };
}

function appConfig() {
  const config = vscode.workspace.getConfiguration("srcMap");
  return {
    appUrl: config.get("appUrl") || "http://localhost:4000",
    debugPort: config.get("debugPort") || 9222,
    chromePath: config.get("chromePath") || "",
  };
}

async function ensureMonitor(context) {
  if (!lastIndex) await reindex(context);
  if (!lastIndex) throw new Error("índice indisponível: não foi possível localizar o proz-frontend");
  if (monitor) return monitor;
  const { appUrl, debugPort } = appConfig();
  monitorContext = context;
  monitor = new RuntimeMonitor({ appUrl, debugPort, getSrcDir: () => (lastIndex ? path.join(lastIndex.root, "src") : null) });

  monitor.on("status", (status) => {
    rtStatus = status;
    if (!status.tabs) {
      currentByTab.clear();
      mountedByTab.clear();
    }
    post({ type: "runtime", status });
  });

  monitor.on("route", ({ tabId, pathname, at }) => {
    if (!matcher) return;
    const match = matcher.match(pathname);
    const pattern = match ? match.pattern : sanitizePath(pathname); // nunca o path cru: pode conter id de pessoa
    const cardIds = match ? match.cardIds : [];
    currentByTab.set(tabId, { pattern, cardIds });
    if (!trail.length || trail[trail.length - 1].pattern !== pattern) {
      trail.push({ at, pattern, cardIds, matched: Boolean(match) });
      if (trail.length > MAX_TRAIL) trail.shift();
    }
    post({ type: "route", route: { at, pattern, cardIds, matched: Boolean(match) }, trail });
  });

  monitor.on("files", ({ tabId, files, hasDebugSource, fibers }) => {
    const ids = new Set();
    for (const file of files) {
      const id = cardIdOfFile(file);
      if (id) ids.add(id);
    }
    mountedByTab.set(tabId, ids);
    mountedInfo = { hasDebugSource, fibers };
    post({ type: "mounted", mounted: unionOf(mountedByTab), mountedInfo });
  });

  monitor.on("click", (raw) => {
    const toCard = (file) => (file ? cardIdOfFile(file) : null);
    const click = {
      id: ++clickSeq,
      at: raw.at,
      name: raw.name,
      host: raw.host,
      inner: raw.inner,
      tag: raw.tag,
      testId: raw.testId,
      file: raw.file,
      line: raw.line,
      cardId: toCard(raw.file),
      route: currentByTab.get(raw.tabId)?.pattern ?? null,
      chain: raw.chain.map((item) => ({ ...item, cardId: toCard(item.file) })),
    };
    clicks.push(click);
    if (clicks.length > MAX_CLICKS) clicks.shift();
    post({ type: "click", click });
  });

  monitor.on("error-captured", (raw) => {
    const current = currentByTab.get(raw.tabId);
    let cardIds = current ? current.cardIds : [];
    if (!cardIds.length && raw.culprit) {
      const owner = cardIdOfFile(raw.culprit.file);
      if (owner) cardIds = [owner];
    }
    const error = {
      id: ++errorSeq,
      at: raw.at,
      kind: raw.kind,
      errorClass: raw.errorClass,
      http: raw.http,
      culprit: raw.culprit,
      path: raw.path,
      route: current ? current.pattern : null,
      cardIds,
    };
    errors.unshift(error);
    if (errors.length > MAX_ERRORS) errors.length = MAX_ERRORS;
    post({ type: "runtimeError", error });
  });
  return monitor;
}

async function waitForDevServer(appUrl) {
  if (await probeUrl(appUrl)) return;
  // BROWSER=none: o CRA não abre o navegador padrão do sistema; quem abre a aba é o Chrome do launch().
  const terminal = vscode.window.createTerminal({ name: "src-map: npm start", cwd: lastIndex.root, env: { BROWSER: "none" } });
  terminal.show(true);
  terminal.sendText("npm start");
  for (let i = 0; i < 90; i++) {
    post({ type: "runtime", status: { status: "starting", tabs: 0, message: `aguardando o dev server (npm start) — ${i * 2}s` } });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await probeUrl(appUrl)) return;
  }
  throw new Error(`o dev server não respondeu em ${appUrl} (confira o terminal "src-map: npm start")`);
}

async function launchRuntime(context) {
  const mon = await ensureMonitor(context);
  const { appUrl, chromePath } = appConfig();
  await waitForDevServer(appUrl);
  await mon.launch({ chromePath, profileDir: path.join(context.globalStorageUri.fsPath, "chrome-profile") });
}

async function attachRuntime(context) {
  const mon = await ensureMonitor(context);
  await mon.attach();
}

function disconnectRuntime() {
  monitor?.stop();
}

function clearErrors(ids) {
  if (!Array.isArray(ids)) errors = [];
  else errors = errors.filter((e) => !ids.includes(e.id));
}

function removeTrailEntry(at) {
  trail = trail.filter((entry) => entry.at !== at);
}

// Mantém só a rota atual (última) — o resto do rastro é descartado.
function clearTrail() {
  trail = trail.slice(-1);
}

function removeClick(id) {
  clicks = clicks.filter((click) => click.id !== id);
}

function resetMap() {
  clearTrail();
  errors = [];
  clicks = [];
}

function runtimeFailure(error) {
  post({ type: "runtime", status: { status: "disconnected", tabs: 0, message: error.message } });
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  panel = vscode.window.createWebviewPanel(VIEW_TYPE, "src-map", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "public")],
  });

  const publicDir = path.join(context.extensionPath, "public");
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(publicDir, "style.css")));
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(publicDir, "app.js")));
  const csp = `default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource};`;
  panel.webview.html = fs
    .readFileSync(path.join(publicDir, "index.html"), "utf8")
    .replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('href="/style.css"', `href="${styleUri}"`)
    .replace('src="/app.js"', `src="${scriptUri}"`);

  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "ready") {
      if (lastIndex) panel.webview.postMessage({ type: "index", payload: lastIndex });
      else reindex(context);
      panel.webview.postMessage(runtimeSnapshot());
    } else if (message?.type === "launch") {
      launchRuntime(context).catch(runtimeFailure);
    } else if (message?.type === "attach") {
      attachRuntime(context).catch(runtimeFailure);
    } else if (message?.type === "disconnect") {
      disconnectRuntime();
    } else if (message?.type === "clearErrors") {
      clearErrors(message.ids);
    } else if (message?.type === "removeTrail") {
      removeTrailEntry(message.at);
    } else if (message?.type === "clearTrail") {
      clearTrail();
    } else if (message?.type === "removeClick") {
      removeClick(message.id);
    } else if (message?.type === "clearClicks") {
      clicks = [];
    } else if (message?.type === "resetMap") {
      resetMap();
    } else if (message?.type === "reindex") {
      reindex(context);
    } else if (message?.type === "open") {
      openFile(message.file, message.line);
    } else if (message?.type === "reveal") {
      const abs = resolveInsideSrc(message.file);
      if (abs) vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(abs));
    }
  });

  panel.onDidDispose(() => {
    panel = null;
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("srcMap.open", () => openPanel(context)),
    vscode.commands.registerCommand("srcMap.reindex", () => {
      if (panel) reindex(context);
      else openPanel(context);
    }),
    vscode.commands.registerCommand("srcMap.launch", () => {
      openPanel(context);
      launchRuntime(context).catch(runtimeFailure);
    }),
    vscode.commands.registerCommand("srcMap.attach", () => {
      openPanel(context);
      attachRuntime(context).catch(runtimeFailure);
    }),
    vscode.window.registerTreeDataProvider("srcMap.dashboardView", {
      getChildren: () => [],
      getTreeItem: (item) => item,
    }),
    new vscode.Disposable(() => {
      clearTimeout(watchTimer);
      monitor?.stop();
      worker?.terminate();
      worker = null;
    })
  );

  if (context.extensionMode === vscode.ExtensionMode.Development) openPanel(context);
}

function deactivate() {
  monitor?.stop();
  worker?.terminate();
}

module.exports = { activate, deactivate };
