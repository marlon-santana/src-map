---
name: install-src-map
description: Install or update the src-map VS Code extension (.vsix) on the developer's own VS Code. Use when the user asks in chat to install, set up, update, or reinstall the src-map extension.
---

# Install the src-map extension

Installs the packaged `.vsix` into the user's regular VS Code (not the
Extension Development Host). Run from the src-map project root. Every step is
idempotent.

## Rules

- Install the extension only. Do not start the proz-frontend dev server, do not
  open Chrome, do not read `.env` files or the user's project code, and never
  ask the user for tokens or passwords.
- No `sudo`, no `--no-verify`, no changes to PATH or system settings.
- If the `code` CLI cannot be found, stop and guide the user (step 6) instead of
  improvising other install paths.

## Steps

1. **Update the repo** (skip if it was just cloned): `git pull --ff-only`. If no
   `src-map-*.vsix` exists in the root, report it instead of building one.
2. **Find the VS Code CLI**, using the first that works:
   - `code --version` (already in PATH). If `code` resolves to another editor
     (for example Cursor), do not use it: the extension would be installed there.
   - macOS: `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`
   - Windows: `$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd`, then
     `$env:ProgramFiles\Microsoft VS Code\bin\code.cmd`
   - Linux: `/usr/bin/code` or `/snap/bin/code`

   The version must be **1.90 or higher**; otherwise tell the user to update VS Code.
3. **Pick the highest-version `.vsix`**:
   - bash: `ls src-map-*.vsix | sort -V | tail -1`
   - PowerShell: `Get-ChildItem src-map-*.vsix | Sort-Object { [version]($_.BaseName -replace 'src-map-','') } | Select-Object -Last 1`
4. **Install or update**: `<code> --install-extension <file>.vsix --force`
5. **Verify**: `<code> --list-extensions --show-versions` must list
   `local-dev.src-map@<version of the .vsix>` (use `grep -i` or `Select-String`
   to filter). If it does not, report the exact error from step 4.
6. **Tell the user what only they can do**, in order:
   1. Reload VS Code: Command Palette → **Developer: Reload Window**.
   2. Open the proz-frontend folder in VS Code (or set `srcMap.projectRoot`).
   3. Open the map: **src-map** icon in the sidebar, or the command
      **src-map: Abrir mapa**.
   4. For live route and errors: **Iniciar** (starts `npm start` if needed and
      opens a dedicated Chrome) or **Anexar** (to a Chrome opened with
      `--remote-debugging-port=9222`).
   5. If `code` was not found: run **Shell Command: Install 'code' command in
      PATH** in VS Code and ask to repeat the install, or follow the manual steps
      in README.md.
   6. Remind them of the "Privacidade e LGPD" section of README.md: only metadata
      is shown, never error messages or request bodies, and screenshots of the app
      or the map must not be shared with personal data or credentials visible.
