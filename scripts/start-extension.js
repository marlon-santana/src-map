"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const extensionPath = path.resolve(__dirname, "..");
// Abre o Dev Host já com o proz-frontend como pasta de trabalho (a extensão detecta o projeto por ela).
const projectRoot = process.env.SRC_MAP_PROJECT_ROOT || process.argv[2];
if (!projectRoot) {
  console.error("Uso: node scripts/start-extension.js <caminho do proz-frontend> (ou defina SRC_MAP_PROJECT_ROOT)");
  process.exit(1);
}

function findVSCode() {
  if (process.platform !== "win32") return "code";

  const candidates = [
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const executable = findVSCode();
if (!executable) {
  console.error(
    "VS Code nao foi encontrado. Instale o Visual Studio Code ou ajuste scripts/start-extension.js para o caminho da instalacao."
  );
  process.exit(1);
}

const child = spawn(
  executable,
  ["--new-window", `--extensionDevelopmentPath=${extensionPath}`, projectRoot],
  { detached: true, stdio: "ignore", windowsHide: true }
);

child.once("error", (error) => {
  console.error(`Falha ao iniciar o VS Code: ${error.message}`);
  process.exitCode = 1;
});

child.once("spawn", () => {
  console.log("Extension Development Host iniciado. O src-map abre automaticamente no modo de desenvolvimento.");
  child.unref();
});
