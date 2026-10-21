"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sanitizeClick, sanitizeTestId } = require("../src/clicks");

const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-map-clicks-"));
fs.mkdirSync(path.join(srcDir, "components"), { recursive: true });
fs.writeFileSync(path.join(srcDir, "components", "Foo.js"), "");
// toSrcRel só olha o trecho "/src/..." do caminho: monta um caminho com esse formato apontando para srcDir.
const fileName = `/whatever/src/components/Foo.js`;

test("valida e normaliza um clique legítimo", () => {
  const payload = JSON.stringify({
    tag: "button",
    testId: "row-48211",
    element: { n: "button", f: fileName, l: 42, host: true, inner: false },
    chain: [{ n: "Foo", f: fileName, l: 42 }, { n: "App", f: "/x/node_modules/lib/i.js", l: 1 }],
  });
  const click = sanitizeClick(payload, srcDir);
  assert.deepStrictEqual(click, {
    name: "button",
    host: true,
    inner: false,
    tag: "button",
    testId: "row-:id",
    file: "components/Foo.js",
    line: 42,
    chain: [
      { name: "Foo", file: "components/Foo.js", line: 42 },
      { name: "App", file: null, line: null },
    ],
  });
});

test("descarta o que não ancora em src/ ou não é JSON válido", () => {
  assert.strictEqual(sanitizeClick("não é json", srcDir), null);
  assert.strictEqual(sanitizeClick(JSON.stringify({ element: { n: "x", f: "/x/node_modules/a/src/b.js", l: 1 } }), srcDir), null);
  assert.strictEqual(sanitizeClick(JSON.stringify({ element: { n: "x", f: "/a/src/nao/existe.js", l: 1 } }), srcDir), null);
  assert.strictEqual(sanitizeClick(JSON.stringify({ element: { n: "x", f: fileName, l: 1 } }), null), null);
  assert.strictEqual(sanitizeClick(JSON.stringify([]), srcDir), null);
});

test("ignora campos desconhecidos e nomes/tags suspeitos (texto da tela não passa)", () => {
  const click = sanitizeClick(
    JSON.stringify({
      tag: "<img onerror=x>",
      text: "João Silva 123.456.789-00",
      testId: "maria@proz.com",
      element: { n: "João Silva 123.456.789-00", f: fileName, l: -3, host: "sim", value: "segredo" },
      chain: [{ n: "<script>", f: fileName, l: 1 }, null, "x"],
    }),
    srcDir
  );
  assert.deepStrictEqual(click, { name: "?", host: false, inner: false, tag: null, testId: null, file: "components/Foo.js", line: null, chain: [] });
  assert.ok(!JSON.stringify(click).includes("João"));
});

test("limita o tamanho da cadeia", () => {
  const chain = Array.from({ length: 50 }, (_, i) => ({ n: `C${i}`, f: fileName, l: i + 1 }));
  const click = sanitizeClick(JSON.stringify({ element: { n: "div", f: fileName, l: 1, host: true }, chain }), srcDir);
  assert.strictEqual(click.chain.length, 8);
});

test("sanitizeTestId troca ids por :id e recusa e-mail/lixo", () => {
  assert.strictEqual(sanitizeTestId("save-btn"), "save-btn");
  assert.strictEqual(sanitizeTestId("row-1234567"), "row-:id");
  assert.strictEqual(sanitizeTestId("a-3f2b8c1d-1111-2222-3333-444455556666"), "a-:id");
  assert.strictEqual(sanitizeTestId("x@y.com"), null);
  assert.strictEqual(sanitizeTestId("<b>"), null);
  assert.strictEqual(sanitizeTestId(""), null);
  assert.strictEqual(sanitizeTestId(null), null);
});
