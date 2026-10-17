"use strict";

const fs = require("fs");
const parser = require("@babel/parser");

const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range"]);

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

function parseSource(source, filename) {
  const isTs = /\.tsx?$/.test(filename);
  return parser.parse(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: isTs ? ["jsx", "typescript"] : ["jsx", "exportDefaultFrom"],
  });
}

function nameOf(node) {
  if (!node) return null;
  return node.type === "Identifier" ? node.name : node.value;
}

// Extrai só estrutura (imports/exports/JSX usado) — nunca guarda código-fonte.
function extractInfo(ast) {
  const info = {
    imports: {}, // local -> { source, imported }
    sources: [], // todo módulo referenciado (import, import(), require)
    exports: {}, // nome -> { type: 'reexport'|'local'|'decl', ... }
    star: [],
    jsxNames: new Set(),
    hasDecl: false,
  };

  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      info.sources.push(node.source.value);
      if (node.importKind === "type") continue;
      for (const spec of node.specifiers) {
        if (spec.type === "ImportDefaultSpecifier") info.imports[spec.local.name] = { source: node.source.value, imported: "default" };
        else if (spec.type === "ImportNamespaceSpecifier") info.imports[spec.local.name] = { source: node.source.value, imported: "*" };
        else info.imports[spec.local.name] = { source: node.source.value, imported: nameOf(spec.imported) };
      }
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.source) {
        info.sources.push(node.source.value);
        for (const spec of node.specifiers) {
          if (spec.type === "ExportNamespaceSpecifier") info.exports[nameOf(spec.exported)] = { type: "reexport", source: node.source.value, imported: "*" };
          else if (spec.type === "ExportDefaultSpecifier") info.exports[nameOf(spec.exported)] = { type: "reexport", source: node.source.value, imported: "default" };
          else info.exports[nameOf(spec.exported)] = { type: "reexport", source: node.source.value, imported: nameOf(spec.local) };
        }
      } else if (node.declaration) {
        info.hasDecl = true;
        const decl = node.declaration;
        if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) if (d.id.type === "Identifier") info.exports[d.id.name] = { type: "decl" };
        } else if (decl.id) {
          info.exports[decl.id.name] = { type: "decl" };
        }
      } else {
        for (const spec of node.specifiers) info.exports[nameOf(spec.exported)] = { type: "local", local: nameOf(spec.local) };
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl.type === "Identifier") info.exports.default = { type: "local", local: decl.name };
      else {
        info.hasDecl = true;
        info.exports.default = { type: "decl" };
      }
    } else if (node.type === "ExportAllDeclaration") {
      info.sources.push(node.source.value);
      info.star.push(node.source.value);
    }
  }

  walk(ast.program, (node) => {
    if (node.type === "CallExpression") {
      const [arg] = node.arguments;
      if (arg && arg.type === "StringLiteral") {
        if (node.callee.type === "Import") info.sources.push(arg.value);
        else if (node.callee.type === "Identifier" && node.callee.name === "require") info.sources.push(arg.value);
      }
    } else if (node.type === "JSXOpeningElement") {
      let name = node.name;
      while (name && name.type === "JSXMemberExpression") name = name.object;
      if (name && name.type === "JSXIdentifier") info.jsxNames.add(name.name);
    }
  });

  info.sources = [...new Set(info.sources)];
  info.jsxNames = [...info.jsxNames];
  info.isBarrel = !info.hasDecl && (info.star.length > 0 || Object.values(info.exports).some((e) => e.type === "reexport"));
  return info;
}

function createParseCache() {
  const cache = new Map(); // abs -> { mtimeMs, info }
  return {
    get(abs) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        return null;
      }
      const hit = cache.get(abs);
      if (hit && hit.mtimeMs === mtimeMs) return hit.info;
      let info;
      try {
        info = extractInfo(parseSource(fs.readFileSync(abs, "utf8"), abs));
      } catch {
        info = { imports: {}, sources: [], exports: {}, star: [], jsxNames: [], hasDecl: false, isBarrel: false };
      }
      cache.set(abs, { mtimeMs, info });
      return info;
    },
  };
}

module.exports = { walk, parseSource, nameOf, createParseCache };
