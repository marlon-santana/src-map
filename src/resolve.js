"use strict";

const path = require("path");

const EXTS = [".js", ".jsx", ".ts", ".tsx"];

// fileSet: caminhos relativos a src/ (posix). getInfo(rel) -> info do parse.js
function createResolver(fileSet, getInfo) {
  function resolveModule(fromRel, spec) {
    let base;
    if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(fromRel), spec);
    else if (spec.startsWith("@components/")) base = `components/${spec.slice("@components/".length)}`;
    else base = spec; // baseUrl = src (jsconfig)
    if (fileSet.has(base)) return base;
    for (const ext of EXTS) if (fileSet.has(base + ext)) return base + ext;
    for (const ext of EXTS) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }

  // Segue barrels (export { default as X } from, export * from, import+export) até o arquivo de origem.
  function resolveExport(fileRel, name, seen = new Set()) {
    const key = `${fileRel}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const info = getInfo(fileRel);
    if (!info) return fileRel;
    const exp = info.exports[name];
    if (exp) {
      if (exp.type === "decl") return fileRel;
      if (exp.type === "reexport") {
        const target = resolveModule(fileRel, exp.source);
        if (!target) return null;
        if (exp.imported === "*") return target;
        return resolveExport(target, exp.imported, seen) || target;
      }
      if (exp.type === "local") {
        const imp = info.imports[exp.local];
        if (!imp) return fileRel;
        return resolveImportBinding(fileRel, imp, seen) || fileRel;
      }
    }
    if (name !== "default") {
      for (const source of info.star) {
        const target = resolveModule(fileRel, source);
        if (!target) continue;
        const found = resolveExport(target, name, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function resolveImportBinding(fromRel, imp, seen = new Set()) {
    const target = resolveModule(fromRel, imp.source);
    if (!target) return null;
    if (imp.imported === "*") return target;
    return resolveExport(target, imp.imported, seen) || target;
  }

  return { resolveModule, resolveExport, resolveImportBinding };
}

module.exports = { createResolver };
