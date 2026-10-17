"use strict";

const fs = require("fs");
const path = require("path");
const { walk, parseSource, nameOf } = require("./parse");

function keyName(prop) {
  if (!prop || prop.computed) return null;
  return nameOf(prop.key);
}

// ROUTE.A.b -> "A.b" (descarta o identificador raiz)
function memberKey(node) {
  const names = [];
  let cur = node;
  while (cur.type === "MemberExpression") {
    if (cur.computed) return null;
    names.unshift(nameOf(cur.property));
    cur = cur.object;
  }
  return cur.type === "Identifier" && names.length ? names.join(".") : null;
}

function evalNode(node, env, globalMap) {
  if (!node) return null;
  switch (node.type) {
    case "StringLiteral":
      return node.value;
    case "TemplateLiteral": {
      let out = "";
      for (let i = 0; i < node.quasis.length; i++) {
        out += node.quasis[i].value.cooked;
        if (i < node.expressions.length) {
          const v = evalNode(node.expressions[i], env, globalMap);
          if (v == null) return null;
          out += v;
        }
      }
      return out;
    }
    case "Identifier":
      return env.has(node.name) ? env.get(node.name) : null;
    case "MemberExpression": {
      const key = memberKey(node);
      return key && globalMap.has(key) ? globalMap.get(key) : null;
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const l = evalNode(node.left, env, globalMap);
      const r = evalNode(node.right, env, globalMap);
      return l == null || r == null ? null : l + r;
    }
    default:
      return null;
  }
}

function collectProps(obj, prefix, env, globalMap) {
  for (const prop of obj.properties) {
    if (prop.type !== "ObjectProperty") continue;
    const name = keyName(prop);
    if (!name) continue;
    const key = prefix + name;
    if (prop.value.type === "ObjectExpression") {
      collectProps(prop.value, `${key}.`, env, globalMap);
    } else if (!globalMap.has(key)) {
      const v = evalNode(prop.value, env, globalMap);
      if (v != null) globalMap.set(key, v);
    }
  }
}

// services/constants/routes/*.js -> mapa CHAVE -> path (as chaves são únicas pois o ROUTE usa spread)
function loadRouteConstants(srcDir) {
  const dir = path.join(srcDir, "services", "constants", "routes");
  const globalMap = new Map();
  if (!fs.existsSync(dir)) return globalMap;
  const parsed = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    try {
      const ast = parseSource(fs.readFileSync(path.join(dir, file), "utf8"), file);
      const env = new Map();
      const objects = [];
      for (const node of ast.program.body) {
        const decl = node.type === "ExportNamedDeclaration" ? node.declaration : node;
        if (!decl || decl.type !== "VariableDeclaration") continue;
        for (const d of decl.declarations) {
          if (d.id.type !== "Identifier" || !d.init) continue;
          if (d.init.type === "ObjectExpression") objects.push(d.init);
          else {
            const v = evalNode(d.init, env, globalMap);
            if (v != null) env.set(d.id.name, v);
          }
        }
      }
      parsed.push({ env, objects });
    } catch {
      // arquivo de constantes ilegível: segue sem ele
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const { env, objects } of parsed) {
      for (const obj of objects) {
        collectProps(obj, "", env, globalMap);
      }
    }
  }
  return globalMap;
}

function isRouteKeyRef(node) {
  let root = node;
  while (root && root.type === "MemberExpression") root = root.object;
  return Boolean(node && node.type === "MemberExpression" && root.type === "Identifier" && /ROUTE/.test(root.name));
}

function collectIdentifiers(node, out = []) {
  walk(node, (n) => {
    if (n.type === "Identifier") out.push(n.name);
    else if (n.type === "JSXIdentifier") out.push(n.name);
  });
  return out;
}

function listRouteFiles(srcDir) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "Component" || entry.name === "helpers") continue;
        visit(abs);
      } else if (/\.jsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name) && entry.name !== "index.js") {
        out.push(abs);
      }
    }
  };
  const routesDir = path.join(srcDir, "routes");
  if (fs.existsSync(routesDir)) visit(routesDir);
  return out;
}

// Retorna [{ routePath, routeKey, routeFile, componentFile }]
function extractRoutes({ srcDir, resolver, getInfo }) {
  const constants = loadRouteConstants(srcDir);
  const entries = [];

  for (const abs of listRouteFiles(srcDir)) {
    const rel = path.relative(srcDir, abs).split(path.sep).join("/");
    let ast;
    try {
      ast = parseSource(fs.readFileSync(abs, "utf8"), abs);
    } catch {
      continue;
    }
    const info = getInfo(rel);
    if (!info) continue;

    const env = new Map();
    const aliases = new Map(); // const X = withY(Z) -> X => [Z]
    for (const node of ast.program.body) {
      if (node.type !== "VariableDeclaration") continue;
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        if (d.init.type === "CallExpression") {
          const ids = [];
          for (const arg of d.init.arguments) collectIdentifiers(arg, ids);
          aliases.set(d.id.name, ids);
        } else {
          const v = evalNode(d.init, env, constants);
          if (v != null) env.set(d.id.name, v);
        }
      }
    }

    const toFiles = (identifiers) => {
      const files = new Set();
      const seen = new Set();
      const follow = (name) => {
        if (seen.has(name)) return;
        seen.add(name);
        const imp = info.imports[name];
        if (imp) {
          const file = resolver.resolveImportBinding(rel, imp);
          if (file) files.add(file);
        } else if (aliases.has(name)) {
          for (const inner of aliases.get(name)) follow(inner);
        }
      };
      identifiers.forEach(follow);
      return [...files];
    };

    const pathOf = (node) => {
      if (!node) return { routePath: null, routeKey: null };
      const routePath = evalNode(node, env, constants);
      const routeKey = isRouteKeyRef(node) ? memberKey(node) : null;
      return { routePath, routeKey };
    };

    walk(ast.program, (node) => {
      if (node.type === "ObjectExpression") {
        const props = node.properties.filter((p) => p.type === "ObjectProperty");
        const comp = props.find((p) => keyName(p) === "component");
        if (!comp) return;
        const pathProp = props.find((p) => keyName(p) === "path");
        const ids = [];
        collectIdentifiers(comp.value, ids);
        const { routePath, routeKey } = pathOf(pathProp && pathProp.value);
        for (const file of toFiles(ids)) entries.push({ routePath, routeKey, routeFile: rel, componentFile: file });
      } else if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        const [first, ...rest] = node.arguments;
        if (!first || !rest.length) return;
        const pathLike = isRouteKeyRef(first) || first.type === "TemplateLiteral" || first.type === "StringLiteral";
        if (!pathLike) return;
        const ids = [];
        for (const arg of rest) {
          if (arg.type === "Identifier") ids.push(arg.name);
          else if (arg.type === "CallExpression") collectIdentifiers(arg, ids);
        }
        const { routePath, routeKey } = pathOf(first);
        for (const file of toFiles(ids)) entries.push({ routePath, routeKey, routeFile: rel, componentFile: file });
      }
    });
  }

  // dedupe
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.routePath || e.routeKey}|${e.routeFile}|${e.componentFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { extractRoutes, loadRouteConstants };
