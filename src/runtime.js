"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { connect } = require("./cdp");
const { createSourceMapper } = require("./sourcemaps");
const { CLICK_BINDING, CLICK_HOOK, sanitizeClick } = require("./clicks");
const { flattenStack, resolveFrames, pickCulprit, looksLikeRenderError, sanitizeEndpoint, toSrcRel } = require("./stack");

const POLL_MS = 1500;
const FILES_MS = 1500;
const DEDUPE_MS = 1500;
const MAX_REQUESTS = 300;

// Roda dentro da página: devolve só nomes de arquivo dos fibers montados (React 17 dev expõe _debugSource).
const WALKER = `(() => {
  const roots = [];
  const containers = [document.getElementById('root'), ...document.querySelectorAll('body > *')];
  for (const c of containers) {
    const r = c && c._reactRootContainer;
    const fiber = r && (r._internalRoot ? r._internalRoot.current : r.current);
    if (fiber && !roots.includes(fiber)) roots.push(fiber);
  }
  const files = new Set();
  let visited = 0;
  for (const rootFiber of roots) {
    const stack = [rootFiber];
    while (stack.length && visited < 80000) {
      const f = stack.pop();
      visited++;
      const s = f._debugSource;
      if (s && s.fileName) files.add(s.fileName);
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
  }
  return JSON.stringify({ files: [...files].slice(0, 800), roots: roots.length, visited });
})()`;

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function probeUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function findChrome() {
  const env = process.env;
  const candidates = [
    env.ProgramFiles && `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    env.ProgramFiles && `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    env["ProgramFiles(x86)"] && `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// Providers de contexto são montados na raiz do app (MainContext) e acenderiam as features de todas as telas.
const GLOBAL_PROVIDER = /(^|\/)[Cc]ontext\/|(Context|Provider)\.[jt]sx?$/;

const safeClassName = (name) => (typeof name === "string" && /^[A-Za-z_$][\w$]{0,59}$/.test(name) ? name : "Error");

// Observa o app no Chrome via CDP. Só metadados saem daqui: o texto da mensagem de erro, URLs com query
// e corpos de request/response nunca são lidos, guardados nem repassados.
class RuntimeMonitor extends EventEmitter {
  constructor({ appUrl, debugPort, getSrcDir }) {
    super();
    this.appUrl = appUrl;
    this.appOrigin = new URL(appUrl).origin;
    this.debugPort = debugPort;
    this.getSrcDir = getSrcDir;
    this.mapper = createSourceMapper({ appOrigin: this.appOrigin });
    this.tabs = new Map();
    this.attaching = new Set();
    this.pollTimer = null;
    this.pendingNavigate = false;
    this.status = "disconnected";
    this.lastErrorKey = new Map();
    this.queue = Promise.resolve();
  }

  _setStatus(status, message = "") {
    const key = `${status}|${this.tabs.size}|${message}`;
    this.status = status;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.emit("status", { status, tabs: this.tabs.size, message });
  }

  isActive() {
    return Boolean(this.pollTimer);
  }

  // Conecta a um Chrome que já esteja com --remote-debugging-port.
  attach() {
    this._startPolling();
    return this._poll();
  }

  async launch({ chromePath, profileDir, headless = false }) {
    const exe = chromePath || findChrome();
    if (!exe) throw new Error("Chrome não encontrado. Defina srcMap.chromePath ou use Anexar.");
    fs.mkdirSync(profileDir, { recursive: true });
    this._setStatus("starting", "abrindo o Chrome…");
    const args = [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (error) => this._setStatus("disconnected", `falha ao abrir o Chrome: ${error.message}`));
    child.unref();
    this.pendingNavigate = true;
    this._startPolling();
    return child;
  }

  _startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pendingNavigate = false;
    for (const tab of [...this.tabs.values()]) this._detach(tab);
    this._setStatus("disconnected", "");
  }

  async _poll() {
    let targets;
    try {
      targets = await getJson(`http://127.0.0.1:${this.debugPort}/json/list`);
    } catch {
      for (const tab of [...this.tabs.values()]) this._detach(tab);
      this._setStatus(
        this.pendingNavigate ? "starting" : "disconnected",
        this.pendingNavigate ? "abrindo o Chrome…" : `porta ${this.debugPort} sem resposta — abra o Chrome com --remote-debugging-port=${this.debugPort} ou use Iniciar`
      );
      return;
    }
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const live = new Set(pages.map((t) => t.id));
    for (const tab of [...this.tabs.values()]) if (!live.has(tab.id)) this._detach(tab);

    for (const target of pages) {
      if (this.tabs.has(target.id) || this.attaching.has(target.id)) continue;
      const isApp = target.url.startsWith(this.appOrigin);
      const isBlank = this.pendingNavigate && target.url.startsWith("about:blank");
      if (!isApp && !isBlank) continue;
      this.attaching.add(target.id);
      try {
        await this._attachTarget(target, isBlank);
      } catch (error) {
        this._setStatus("disconnected", `falha ao conectar na aba: ${error.message}`);
      } finally {
        this.attaching.delete(target.id);
      }
    }
    if (this.tabs.size) this._setStatus("connected");
    else if (this.status !== "starting") this._setStatus("waiting", `Chrome conectado — aguardando uma aba em ${this.appUrl}`);
  }

  async _attachTarget(target, navigate) {
    const client = await connect(target.webSocketDebuggerUrl);
    const tab = { id: target.id, client, url: target.url, requests: new Map(), filesKey: null, filesTimer: null };
    client.onClose(() => this._detach(tab));
    client.on("Page.navigatedWithinDocument", ({ url }) => this._emitRoute(tab, url));
    client.on("Page.frameNavigated", ({ frame }) => {
      if (frame.parentId) return;
      this.mapper.clear();
      this._emitRoute(tab, frame.url);
    });
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => this._enqueue(() => this._handleException(tab, exceptionDetails)));
    client.on("Network.requestWillBeSent", (params) => {
      if (params.type !== "XHR" && params.type !== "Fetch") return;
      if (tab.requests.size >= MAX_REQUESTS) tab.requests.delete(tab.requests.keys().next().value);
      tab.requests.set(params.requestId, { method: params.request.method, url: params.request.url, stack: params.initiator && params.initiator.stack });
    });
    client.on("Network.responseReceived", ({ requestId, response }) => {
      const info = tab.requests.get(requestId);
      if (info && response.status >= 400) this._enqueue(() => this._handleHttp(tab, info, response.status));
    });
    client.on("Network.loadingFailed", ({ requestId, canceled }) => {
      const info = tab.requests.get(requestId);
      tab.requests.delete(requestId);
      if (info && !canceled) this._enqueue(() => this._handleHttp(tab, info, 0));
    });
    client.on("Network.loadingFinished", ({ requestId }) => tab.requests.delete(requestId));
    client.on("Runtime.bindingCalled", ({ name, payload }) => {
      if (name === CLICK_BINDING) this._handleClick(tab, payload);
    });

    await client.send("Runtime.enable");
    await client.send("Network.enable");
    await client.send("Page.enable");
    await client.send("Debugger.enable");
    await client.send("Debugger.setSkipAllPauses", { skip: true });
    await client.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });

    await this._installClickHook(client);

    this.tabs.set(tab.id, tab);
    tab.filesTimer = setInterval(() => this._pollFiles(tab), FILES_MS);
    if (navigate) {
      this.pendingNavigate = false;
      await client.send("Page.navigate", { url: this.appUrl });
    } else {
      this._emitRoute(tab, target.url);
    }
    this._setStatus("connected");
  }

  // Escuta de cliques injetada só no navegador (nada no repo). Falhar aqui não derruba rota/erros.
  async _installClickHook(client) {
    try {
      await client.send("Runtime.addBinding", { name: CLICK_BINDING });
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: CLICK_HOOK });
      await client.send("Runtime.evaluate", { expression: CLICK_HOOK }); // aba já carregada
    } catch (error) {
      console.error(`[src-map] hook de clique indisponível: ${error.message}`);
    }
  }

  _handleClick(tab, payload) {
    if (typeof payload !== "string" || payload.length > 20000) return;
    const click = sanitizeClick(payload, this.getSrcDir());
    if (click) this.emit("click", { tabId: tab.id, at: Date.now(), ...click });
  }

  _detach(tab) {
    if (!this.tabs.has(tab.id)) return;
    clearInterval(tab.filesTimer);
    this.tabs.delete(tab.id);
    tab.client.close();
    this._setStatus(this.tabs.size ? "connected" : "waiting", this.tabs.size ? "" : `aguardando uma aba em ${this.appUrl}`);
  }

  _emitRoute(tab, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.origin !== this.appOrigin) return;
    tab.url = url;
    this.emit("route", { tabId: tab.id, pathname: parsed.pathname, at: Date.now() });
    tab.filesKey = null; // força reenvio dos componentes montados na nova rota
    setTimeout(() => this._pollFiles(tab), 700);
  }

  async _pollFiles(tab) {
    if (!this.tabs.has(tab.id)) return;
    try {
      const result = await tab.client.send("Runtime.evaluate", { expression: WALKER, returnByValue: true });
      const value = result && result.result && result.result.value;
      if (typeof value !== "string") return;
      const { files, roots, visited } = JSON.parse(value);
      const srcDir = this.getSrcDir();
      const rels = srcDir ? [...new Set(files.map((f) => toSrcRel(f, srcDir)).filter((f) => f && !GLOBAL_PROVIDER.test(f)))].sort() : [];
      const key = rels.join("|");
      if (key === tab.filesKey) return;
      tab.filesKey = key;
      this.emit("files", { tabId: tab.id, files: rels, hasDebugSource: files.length > 0, roots, fibers: visited });
    } catch {
      // aba navegando ou fechando: tenta no próximo ciclo
    }
  }

  _enqueue(task) {
    this.queue = this.queue.then(task).catch((error) => console.error(`[src-map] ${error.message}`));
  }

  _emitError(tab, error) {
    const key = [error.kind, error.errorClass, error.culprit && `${error.culprit.file}:${error.culprit.line}`, error.http && `${error.http.method} ${error.http.endpoint} ${error.http.status}`].join("|");
    const last = this.lastErrorKey.get(key);
    const now = Date.now();
    if (last && now - last < DEDUPE_MS) return;
    this.lastErrorKey.set(key, now);
    this.emit("error-captured", { tabId: tab.id, at: now, ...error });
  }

  async _handleException(tab, details) {
    // Só className, tipo e frames. details.text / exception.description (a mensagem) nunca são lidos,
    // exceto o teste booleano de "in promise" para classificar o tipo.
    let frames = flattenStack(details.stackTrace);
    if (!frames.length && details.url) {
      frames = [{ url: details.url, lineNumber: details.lineNumber || 0, columnNumber: details.columnNumber || 0, functionName: "" }];
    }
    if (!frames.some((f) => f.url && f.url.startsWith(this.appOrigin))) return; // erro de extensão/terceiros
    const ex = details.exception;
    const errorClass = ex ? safeClassName(ex.className) : "NonError";
    const isPromise = typeof details.text === "string" && details.text.includes("in promise");
    const syncFrames = (details.stackTrace && details.stackTrace.callFrames) || frames; // render só vale na pilha síncrona
    const kind = isPromise ? "rejection" : looksLikeRenderError(syncFrames) ? "render" : "exception";
    const srcFrames = await resolveFrames(frames, { mapper: this.mapper, srcDir: this.getSrcDir() });
    const { culprit, path } = pickCulprit(srcFrames, "exception");
    this._emitError(tab, { kind, errorClass, culprit, path, http: null });
  }

  async _handleHttp(tab, info, status) {
    const endpoint = sanitizeEndpoint(info.url);
    if (!endpoint) return;
    let origin = "";
    try {
      origin = new URL(info.url).origin;
    } catch {
      return;
    }
    if (origin === this.appOrigin && /^\/(static|sockjs-node|ws)\b|hot-update/.test(endpoint)) return;
    const frames = flattenStack(info.stack);
    const srcFrames = await resolveFrames(frames, { mapper: this.mapper, srcDir: this.getSrcDir() });
    if (!srcFrames.length) return; // chamada que não nasceu no código do app (analytics, extensões…)
    const { culprit, path } = pickCulprit(srcFrames, "http");
    this._emitError(tab, {
      kind: "http",
      errorClass: status ? `HTTP ${status}` : "NetworkError",
      culprit,
      path,
      http: { method: String(info.method || "GET").toUpperCase(), status, endpoint },
    });
  }
}

module.exports = { RuntimeMonitor, findChrome, probeUrl };
