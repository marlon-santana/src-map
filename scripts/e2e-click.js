"use strict";

// Teste ponta a ponta do clique: Chrome headless (porta própria, perfil temporário) contra uma página mínima
// com React 17 em dev e `__source` simulado (o que o babel do CRA injeta). Nada de rede externa nem do app real.
// Uso: node scripts/e2e-click.js <caminho do proz-frontend>
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { RuntimeMonitor } = require("../src/runtime");
const { connect } = require("../src/cdp");

const projectRoot = process.argv[2] || process.env.SRC_MAP_PROJECT_ROOT;
if (!projectRoot) {
  console.error("Uso: node scripts/e2e-click.js <caminho do proz-frontend>");
  process.exit(1);
}
const srcDir = path.join(projectRoot, "src");
const PORT = 4871;
const DEBUG_PORT = 9333;

const TOOLBAR_REL = "components/pages/Admin/Secretary/SchoolClass/BindByUnbinded/components/TableBindByUnbinded/Toolbar/index.js";
const TABLE_REL = "components/pages/Admin/Secretary/SchoolClass/BindByUnbinded/components/TableBindByUnbinded/index.js";
const abs = (rel) => path.join(srcDir, rel);
for (const rel of [TOOLBAR_REL, TABLE_REL]) assert.ok(fs.existsSync(abs(rel)), `arquivo de teste não existe: ${rel}`);

const PAGE = `<!doctype html><meta charset="utf-8"><title>e2e</title><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
const h = React.createElement;
const src = (fileName, lineNumber) => ({ fileName, lineNumber });
const TOOLBAR = ${JSON.stringify(abs(TOOLBAR_REL))};
const TABLE = ${JSON.stringify(abs(TABLE_REL))};
const LIB = "C:\\\\x\\\\node_modules\\\\some-lib\\\\index.js";

// "lib": o host <button> nasce em node_modules (sem fonte em src/); o chamador em src/ é quem escreve <LibButton>.
function LibButton(props) {
  return h("button", { __source: src(LIB, 3), "data-testid": props["data-testid"] }, props.children);
}
function Toolbar() {
  return h("div", { __source: src(TOOLBAR, 10) },
    h("button", { id: "plain", __source: src(TOOLBAR, 42), "data-testid": "bind-btn-48211", style: { width: 200, height: 40 } }, "João Silva 123.456.789-00"),
    h(LibButton, { __source: src(TOOLBAR, 55), "data-testid": "lib-btn" }, "Salvar")
  );
}
function Table() {
  return h("section", { __source: src(TABLE, 20) }, h(Toolbar, { __source: src(TABLE, 21) }));
}
ReactDOM.render(h(Table, { __source: src(TABLE, 99) }), document.getElementById("root"));
</script>`;

const assets = {
  "/react.js": path.join(projectRoot, "node_modules/react/umd/react.development.js"),
  "/react-dom.js": path.join(projectRoot, "node_modules/react-dom/umd/react-dom.development.js"),
};

const server = http.createServer((req, res) => {
  if (assets[req.url]) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(fs.readFileSync(assets[req.url]));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
};

async function main() {
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-map-e2e-"));
  const monitor = new RuntimeMonitor({ appUrl: `http://localhost:${PORT}/`, debugPort: DEBUG_PORT, getSrcDir: () => srcDir });
  const clicks = [];
  monitor.on("click", (click) => clicks.push(click));
  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await monitor.launch({ chromePath: process.env.CHROME_PATH || "", profileDir, headless: true });
    const tab = await waitFor(() => [...monitor.tabs.values()][0], "aba conectada");
    await waitFor(async () => {
      const r = await tab.client.send("Runtime.evaluate", { expression: "Boolean(window.__srcMapHook) && Boolean(document.querySelector('#plain'))", returnByValue: true });
      return r.result.value;
    }, "hook instalado e página renderizada");

    const clickAt = async (selector) => {
      const r = await tab.client.send("Runtime.evaluate", {
        expression: `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify([b.x + b.width / 2, b.y + b.height / 2]); })()`,
        returnByValue: true,
      });
      const [x, y] = JSON.parse(r.result.value);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await tab.client.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    };

    // 1) Clique real em <button> escrito em src/: arquivo:linha do JSX, testid sem id, cadeia de donos.
    await clickAt("#plain");
    const first = await waitFor(() => clicks[0], "clique no botão simples");
    assert.strictEqual(first.name, "button");
    assert.strictEqual(first.host, true);
    assert.strictEqual(first.inner, false);
    assert.strictEqual(first.file, TOOLBAR_REL);
    assert.strictEqual(first.line, 42);
    assert.strictEqual(first.testId, "bind-btn-:id");
    assert.deepStrictEqual(
      first.chain.map((c) => [c.name, c.file, c.line]),
      [["Toolbar", TOOLBAR_REL, 42], ["Table", TABLE_REL, 21]]
    );

    // 2) Clique em elemento de lib: cai no <LibButton> escrito em src/ (inner = true).
    await clickAt("[data-testid=lib-btn]");
    const second = await waitFor(() => clicks[1], "clique no botão da lib");
    assert.strictEqual(second.name, "LibButton");
    assert.strictEqual(second.host, false);
    assert.strictEqual(second.inner, true);
    assert.strictEqual(second.file, TOOLBAR_REL);
    assert.strictEqual(second.line, 55);

    // 3) Clique sintético (element.click() do próprio script) é ignorado.
    await tab.client.send("Runtime.evaluate", { expression: "document.querySelector('#plain').click()" });
    await sleep(600);
    assert.strictEqual(clicks.length, 2, "clique não confiável não deve gerar evento");

    // 4) Depois de navegar (novo documento) o hook volta sozinho.
    await tab.client.send("Page.navigate", { url: `http://localhost:${PORT}/outra` });
    await waitFor(async () => {
      const r = await tab.client.send("Runtime.evaluate", { expression: "Boolean(window.__srcMapHook) && Boolean(document.querySelector('#plain'))", returnByValue: true });
      return r.result.value;
    }, "hook reinstalado após navegação");
    await clickAt("#plain");
    await waitFor(() => clicks[2], "clique após navegação");

    // 5) LGPD: nada do texto da tela (nome, CPF) nem o id do testid aparece no que sai do monitor.
    const dump = JSON.stringify(clicks);
    for (const forbidden of ["João", "Silva", "123.456", "48211", "Salvar"]) {
      assert.ok(!dump.includes(forbidden), `dado da tela vazou no evento de clique: ${forbidden}`);
    }
    assert.ok(!logs.some((l) => l.includes("hook de clique indisponível")), logs.join("\n"));
    console.log("e2e-click: ok (3 cliques, hook sobrevive à navegação, texto da tela não vaza)");
  } finally {
    console.error = origError;
    try {
      const version = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject));
      const browser = await connect(version.webSocketDebuggerUrl);
      await browser.send("Browser.close").catch(() => {});
    } catch {
      // Chrome já fechou
    }
    monitor.stop();
    server.close();
    await sleep(1500);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // o Chrome no Windows pode segurar um arquivo do perfil por mais um instante; é pasta temporária
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`e2e-click: FALHOU — ${error.stack || error.message}`);
    process.exit(1);
  }
);
