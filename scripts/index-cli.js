"use strict";

// Uso: node scripts/index-cli.js [caminho do proz-frontend] [--json]
const path = require("path");
const { buildIndex } = require("../src/indexer");

const arg = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || process.env.SRC_MAP_PROJECT_ROOT;
if (!arg) {
  console.error("Uso: node scripts/index-cli.js <caminho do proz-frontend> [--json]");
  process.exit(1);
}
const root = path.resolve(arg);
const index = buildIndex(path.join(root, "src"));
if (process.argv.includes("--json")) {
  const { files, ...rest } = index;
  console.log(JSON.stringify(rest));
} else {
  console.log(`${index.cards.length} cards em ${index.elapsedMs}ms`, index.stats);
  const lanes = {};
  for (const c of index.cards) lanes[c.lane] = (lanes[c.lane] || 0) + 1;
  console.table(lanes);
}
