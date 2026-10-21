# src-map

Extensão do VS Code que mapeia a árvore de componentes do `proz-frontend` (React + CRA): acha o componente que você vai mexer e o arquivo onde o erro estourou. O visual e os filtros seguem o `cc-activity-map`. Veja o `SPEC.md` para o desenho completo.

- **Mapa:** um card por feature (a pasta do componente de cada rota) e uma seção "Compartilhados". Clique abre a árvore de arquivos e as dependências; clique num arquivo abre no editor.
- **Rota atual:** com o Chrome conectado, o card da tela em que você está pulsa, os visitados deixam rastro e uma barra mostra as últimas 10 rotas.
- **Erros:** exceção, erro de render, promise rejeitada e HTTP 4xx/5xx deixam o card vermelho. Ao abrir o card, o arquivo da função que quebrou fica com borda vermelha (e o caminho de chamada em laranja). Clique abre na linha.

> **Escopo:** a extensão é específica do `proz-frontend` (estrutura `src/components/pages`, `src/routes`, `services/constants/routes`). Em outro repositório ela mostra "proz-frontend não encontrado".

## Instalação via Claude Code (recomendado)

Não precisa seguir os passos manuais: abra o Claude Code (no VS Code ou no terminal), em qualquer pasta, e cole o prompt abaixo.

````text
Instale a extensão VS Code "src-map" para mim, seguindo a seção
"Instruções para o agente (Claude Code)" do README do repositório
https://github.com/marlon-santana/src-map (leia o README no GitHub antes
de executar). No final, me diga o que foi instalado e o que eu preciso fazer manualmente.
````

Depois que o repositório estiver clonado, o mesmo fluxo fica disponível como a skill `/install-src-map` (em `.claude/skills/install-src-map/`), útil para atualizar a extensão numa versão nova.

O Claude Code vai pedir permissão para `git clone` e para `code --install-extension`. Aprove normalmente; **não** é necessário liberar nada além disso.

### Instruções para o agente (Claude Code)

> Esta seção é escrita para ser executada pelo Claude Code. Siga os passos em ordem, sem pular a verificação final. Todos os passos são idempotentes (podem ser repetidos sem efeito colateral).

**Regras:**

- Instalar apenas a extensão. **Não** iniciar o dev server do `proz-frontend`, **não** abrir o Chrome, **não** ler arquivos `.env` nem código do projeto do usuário e **não** pedir tokens ou senhas.
- Não usar `--no-verify`, `sudo` nem alterar PATH/configurações do sistema. Se o comando `code` não for encontrado, seguir o passo 2 e, se ainda assim falhar, parar e orientar o usuário (passo 6).
- Não publicar nem enviar nada para fora da máquina.

**Passo 1 — Identificar o sistema e baixar o repositório**

Diretório sugerido: `~/claude-tools/src-map` (no Windows, `$HOME\claude-tools\src-map`). Se a pasta já existir, rodar `git pull` nela em vez de clonar de novo.

```bash
# macOS / Linux / Git Bash
mkdir -p ~/claude-tools && cd ~/claude-tools
[ -d src-map ] && git -C src-map pull --ff-only \
  || git clone https://github.com/marlon-santana/src-map.git
cd src-map
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\claude-tools" | Out-Null
Set-Location "$HOME\claude-tools"
if (Test-Path src-map) { git -C src-map pull --ff-only } else { git clone https://github.com/marlon-santana/src-map.git }
Set-Location src-map
```

**Passo 2 — Localizar o CLI do VS Code**

Testar nesta ordem e usar o primeiro que existir:

1. `code --version` (já no PATH). Atenção: se o PATH apontar para outro editor (por exemplo o Cursor), o `--install-extension` instalaria nele. Confira com `code --version`/`code --help` e, se não for o VS Code, use o caminho completo abaixo.
2. macOS: `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`
3. Windows: `$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd`, depois `$env:ProgramFiles\Microsoft VS Code\bin\code.cmd`
4. Linux: `/usr/bin/code` ou `/snap/bin/code`

Conferir que a versão é **1.90 ou superior**. Se for menor, parar e avisar o usuário para atualizar o VS Code.

**Passo 3 — Escolher o `.vsix` de maior versão**

```bash
VSIX=$(ls src-map-*.vsix | sort -V | tail -1)
```

```powershell
$vsix = Get-ChildItem src-map-*.vsix | Sort-Object { [version]($_.BaseName -replace 'src-map-','') } | Select-Object -Last 1
```

**Passo 4 — Instalar (ou atualizar)**

```bash
"<caminho-do-code>" --install-extension "$VSIX" --force
```

`--force` garante a atualização caso já exista uma versão instalada.

**Passo 5 — Verificar**

```bash
"<caminho-do-code>" --list-extensions --show-versions | grep -i src-map
```

No Windows, trocar o `grep` por `Select-String -Pattern src-map`. O resultado esperado é `local-dev.src-map@<versão do .vsix>`. Se não aparecer, reportar o erro exato do passo 4 em vez de tentar outros caminhos.

**Passo 6 — Orientar o usuário (o agente não consegue fazer isso)**

Dizer ao usuário, nesta ordem:

1. Recarregar o VS Code: `Ctrl+Shift+P` (`Cmd+Shift+P` no Mac) → **Developer: Reload Window**.
2. Abrir a pasta do `proz-frontend` no VS Code (ou definir `srcMap.projectRoot` nas configurações com o caminho dele).
3. Abrir o mapa: ícone **src-map** na barra lateral, ou o comando **src-map: Abrir mapa**.
4. Para ver rota e erros em tempo real: **Iniciar** (sobe o `npm start` se preciso e abre um Chrome com perfil próprio) ou **Anexar** (a um Chrome aberto com `--remote-debugging-port=9222`).
5. Se o `code` não foi encontrado no passo 2: no VS Code, rodar **Shell Command: Install 'code' command in PATH** e pedir ao Claude Code para repetir a instalação; ou usar a instalação manual abaixo.
6. Lembrar do aviso de **Privacidade e LGPD** desta página.

## Instalação manual no VS Code

Alternativa quando não for usar o Claude Code para instalar. **Não é preciso ter Node.js** para instalar a extensão (o `.vsix` já leva as dependências); o Node só é necessário para rodar o `npm start` do `proz-frontend`.

### Requisitos

- VS Code **1.90 ou superior**.
- Chrome ou Edge, para a parte de rota e erros em tempo real.
- Git (só para baixar o repositório; também dá para baixar o `.vsix` direto pelo site do GitHub).

### Passos

1. Baixe o repositório: `git clone https://github.com/marlon-santana/src-map.git` (ou baixe o `.vsix` de maior versão pelo GitHub, em **Download raw file**).
2. Instale: aba **Extensions** (`Ctrl+Shift+X`) → `...` → **Install from VSIX...** e escolha o `src-map-<versão>.vsix`. Ou, no terminal, dentro da pasta: `code --install-extension src-map-<versão>.vsix --force`.
3. Recarregue o VS Code (**Developer: Reload Window**).
4. Abra a pasta do `proz-frontend` e clique no ícone **src-map** na barra lateral → **Abrir src-map**.

Para atualizar, baixe o `.vsix` mais novo e repita o passo 2.

### Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| "proz-frontend não encontrado" | Abra a pasta do `proz-frontend` no VS Code ou defina `srcMap.projectRoot`. |
| O ícone **src-map** não aparece | Rode **Developer: Reload Window** e confirme em Extensions que "src-map" está habilitada. |
| **Anexar** diz que a porta 9222 não responde | Abra o Chrome com `--remote-debugging-port=9222 --user-data-dir=<pasta>` ou use **Iniciar**. |
| Os cards não ficam vermelhos | Só entram erros de código do app (frames em `src/`). Erros dentro de libs deixam só o card da rota vermelho. |

## Como usar

- Clique num card para ver a pasta do componente e as dependências; clique num arquivo para abri-lo. `↗` no card abre o componente principal direto.
- A busca acha cards (nome, rota, arquivos da pasta) e arquivos de `src/`.
- **Iniciar** — se `localhost:4000` não responde, abre um terminal com `npm start`; em seguida abre um Chrome com perfil próprio (a sessão de login fica salva nele) já no app.
- **Anexar** — conecta a um Chrome já aberto com `--remote-debugging-port=9222`. Em abas já carregadas a rota e os erros funcionam; recarregue a aba só se os componentes montados não aparecerem.
- **Desconectar** — para de observar. O Chrome continua aberto.
- **Cliques na tela do sistema** — com o Chrome conectado, clicar em qualquer elemento do app faz aparecer, na barra **cliques** (abaixo do rastro de rotas), um chip com o elemento (`<button>`, `<Select />`), o `data-testid`, o `arquivo:linha` do JSX onde ele foi escrito e o componente que o renderiza. O card dono do arquivo ganha destaque azul e o mapa rola até ele (**seguir clique**). Clicar no chip abre o arquivo na linha do elemento; o `×` fecha o chip. Se o clique cair dentro de um filho ou de uma lib (ex.: o `<button>` interno de um componente do MUI), o chip aponta o `<Componente />` mais próximo escrito em `src/`. Precisa do React em modo dev (`_debugSource`), como os componentes montados.
- Filtros e controles do cabeçalho: abas **Mapa / Erros**, papéis, "esconder compartilhados", **seguir rota atual**, **seguir clique**, **mostrar caminho laranja**, "mostrar rotas", **Limpar erros**, Reindexar. Scroll dá zoom e arrastar move o canvas.

## Privacidade e LGPD

- Tudo roda **localmente** na sua máquina; nada é enviado a um servidor.
- Só metadados, em memória. O código **nunca** guarda nem mostra: mensagem de erro, corpo de request/response, query string. IDs, CPFs e e-mails em paths viram `:id`. O Chrome entrega a descrição do erro ao processo da extensão, mas o código lê só o nome da classe (`TypeError`) e os frames.
- O perfil do Chrome criado por **Iniciar** guarda a sessão do app no disco da extensão (como um navegador normal). Apague a pasta `chrome-profile` no armazenamento global da extensão se não quiser isso.
- Cliques: a extensão injeta, só no navegador, um ouvinte de clique (nada é escrito no repo). Dele saem apenas nome da tag/componente, `arquivo:linha`, nomes dos componentes pais e o `data-testid` (com números longos e UUIDs trocados por `:id`). **Nunca** saem o texto da tela, valores de campos, classes, `href`, `aria-label` nem a posição do mouse. O chip mostra só isso, em memória (últimos 10).
- **Não compartilhe prints** do mapa ou do app sem conferir se há dados pessoais ou credenciais visíveis.
- Use apenas em máquinas autorizadas e em conformidade com a política de uso de IA e de dados da sua empresa.

## Configuração

- `srcMap.projectRoot` — caminho do `proz-frontend`. Vazio = detecta entre as pastas do workspace.
- `srcMap.appUrl` — URL do app (padrão `http://localhost:4000`; use a porta do seu dev server).
- `srcMap.debugPort` — porta de depuração do Chrome (padrão `9222`).
- `srcMap.chromePath` — `chrome.exe`/`msedge.exe`; vazio = detecta.

## Desenvolvimento

```bash
git clone https://github.com/marlon-santana/src-map.git
cd src-map
npm install
npm run start:extension -- <caminho do proz-frontend>   # Extension Development Host com o projeto aberto
npm run index -- <caminho do proz-frontend>             # resumo do índice, sem VS Code
```

Também dá para abrir esta pasta no VS Code e pressionar `F5`. Para empacotar uma versão nova:

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension src-map-<versão>.vsix --force
```

O publisher `local-dev` no `package.json` é um identificador local; troque-o por um publisher registrado antes de publicar no Marketplace.
