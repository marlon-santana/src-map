# src-map — Especificação

Extensão pessoal do VS Code, fora de qualquer repositório da Proz, que mapeia a
árvore de componentes do `proz-frontend` para achar rápido **qual componente mexer**
e **em qual arquivo o erro estourou**. Visual e filtros seguem o `cc-activity-map`.

## Decisões (acordadas no /grill-me)

| Tema | Decisão |
|---|---|
| Card | Uma pasta de feature = o diretório do componente que uma rota de `src/routes/**` importa. Agrupado por papel (Admin/Professor/Student/Shared/PDF) e módulo. |
| Compartilhados | atoms/molecules/organisms/templates viram cards numa seção "Compartilhados" recolhida (para poder ficar vermelho). Cada um é o diretório mais alto, não-barrel, com `index.*`. |
| Árvore ao clicar | Pasta física (componente, service, dto, hooks, styles, specs) + seção "Dependências" (cadeia de imports resolvida através de barrels). |
| Abrir arquivo | Aba normal (`preview: false`). Arquivo com erro abre na linha do frame culpado. |
| Captura de runtime | Chrome DevTools Protocol, **sem tocar no repo**. Chrome com perfil próprio persistente em `localhost:4000` (botão Iniciar) ou anexar a um Chrome já com `--remote-debugging-port`. |
| Card atual | URL → padrão de rota → card, enriquecido pelos fibers do React (`_debugSource`, React 17 dev). Se não houver `_debugSource`, degrada para só a rota. |
| Erros | Exceção JS não tratada, promise rejeitada, erro de render (error boundary) e HTTP 4xx/5xx. `console.error` fica de fora. |
| Arquivo culpado | Frame mais profundo em `src/` que não seja infra (`services/api/http/*`). Borda vermelha forte; demais frames do stack em laranja ("no caminho"). Sem frame em `src/` → frame de `src/` mais próximo; se não houver, só o card ativo fica vermelho. |
| Cards vermelhos | Forte: card ativo da rota no erro. Fraco: demais cards que importam o arquivo quebrado. |
| Ciclo do vermelho | Até limpar (por card ou geral) + painel dos últimos ~50 erros, só em memória. |
| Dependências | `@babel/parser`, `ws` e `@jridgewell/trace-mapping` embutidos no `.vsix`. |
| Visual | Tema, painel, abas, toggles, canvas com pan/zoom, cards `.node` e overlay `.details` copiados do `cc-activity-map`. |
| Clique | Ouvinte de `click` (captura, só eventos confiáveis) injetado via CDP (`Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument`), sem tocar no repo. Sobe pelos fibers até o primeiro com `_debugSource` em `src/` (o JSX onde o elemento foi escrito; para lib, o `<Componente />` do app). Chip na barra "cliques", card dono destacado em azul, toggle "seguir clique", últimos 10 em memória. |

## LGPD (regra fixa)

Só metadados. Nada vai para disco.

- Mostrar: tipo do erro, rota, hora, `arquivo:linha`, nome da função, nome da classe do erro (`TypeError`) e, no HTTP, método + status + caminho com IDs trocados por `:id`.
- **Nunca** guardar nem exibir: corpo de request/response, query string, mensagem crua do erro (pode embutir CPF, e-mail, nome).
- O CDP entrega ao extension host a descrição completa da exceção (com a mensagem), mas o código só lê `className`, o tipo e os frames; a mensagem nunca é copiada, guardada, logada nem enviada ao painel. Os testes verificam que credenciais digitadas e o texto do erro não aparecem nas mensagens ao webview.
- O perfil do Chrome criado por **Iniciar** persiste a sessão do app em disco (como um navegador normal) dentro do armazenamento da extensão. Apague a pasta `chrome-profile` se não quiser isso.
- Cliques: do navegador só saem tag/nome de componente, `arquivo:linha`, nomes dos componentes pais e `data-testid` (números ≥ 3 dígitos e UUIDs → `:id`; e-mail ou caracteres fora de `[w-:. ]` descartam o campo). Nunca texto, valor, classe, `href`, `aria-label` ou coordenadas. O payload da página é tratado como não confiável: `src/clicks.js` valida o formato e o arquivo contra `<projeto>/src`. Teste: `npm test` (sanitizador) e `npm run test:e2e-click -- <proz-frontend>` (Chrome headless, confere que nome/CPF da tela não vazam).
- Um toggle de "mostrar mensagem" só poderia existir desligado por padrão, exibindo apenas na tela. Decisão futura do usuário.
- O perfil dedicado do Chrome isola o `localStorage` do app (sessão, usuário) do navegador pessoal.
- A Proz monitora o uso do Claude de forma detalhada: ferramenta de uso interno ligada ao `proz-frontend`.

## Fases

1. **Mapa estático** — feita. Índice de pastas e imports, cards por papel, árvore de arquivos, dependências, abrir no VS Code, busca (cards, rotas e arquivos), reindexação por file watcher.
2. **Runtime de rota** — feita. CDP, card atual com pulso, rastro que esmaece (`visited`), cards com componentes montados (`mounted`), barra com as últimas 10 rotas, toggle "seguir rota atual". O spike confirmou que o `_debugSource` do React 17 existe neste CRA.
3. **Erros** — feita. Stack com sourcemap, vermelho forte/fraco, borda no arquivo culpado, laranja no caminho, aba "Erros" (últimos 50, em memória), toggle "mostrar caminho laranja", "Limpar erros" geral e por card.

4. **Cliques** — feita. Clique no sistema → chip com elemento, `arquivo:linha`, componentes pais e `data-testid`; card dono em azul; abrir o arquivo na linha.

Fora de escopo: `console.error` como erro, persistência em disco, grafo com setas, outros projetos, "copiar contexto para o Claude".

## Como o runtime funciona

```
Chrome (--remote-debugging-port) ←CDP/ws→ src/runtime.js (extension host)
   Page.navigatedWithinDocument / frameNavigated  → rota (pathname)  → routematch → cards
   Runtime.evaluate (walker dos fibers a cada 1,5 s) → arquivos de _debugSource → cards montados
   Runtime.exceptionThrown   → className + frames  ┐
   Network.* (XHR/Fetch ≥ 400 ou falha) + initiator ┴→ sourcemap (bundle.js.map) → arquivo:linha em src/
```

- **Iniciar:** se `localhost:4000` não responde, abre um terminal `npm start`; depois abre um Chrome com perfil próprio (`globalStorage/chrome-profile`) e navega para o app. **Anexar:** conecta a um Chrome já aberto com `--remote-debugging-port` (padrão 9222). Alterar `srcMap.appUrl`, `srcMap.debugPort` e `srcMap.chromePath` nas configurações.
- **Arquivo culpado:** em *exceção/rejeição/render* é o frame mais interno em `src/` (a função que de fato lançou, inclusive `services/api/http/*`). Em *HTTP* é o primeiro frame de `src/` que não seja infra (quem fez a chamada). Divergência deliberada do texto original do grill-me, que aplicava a exclusão de infra aos dois casos: com ela o `TypeError` de `httpClient.js` apontaria para `login` e esconderia a função que realmente quebrou. Troque em `pickCulprit` (`src/stack.js`) se preferir a regra única.
- **Vermelho fraco:** só para arquivos fora de infra e com ≤ 25 cards importando (acima disso o erro fica só no painel).
- **Componentes montados:** o `_debugSource` do fiber aponta o arquivo onde o JSX foi escrito. Providers de contexto (`**/Context/**`, `*Context.js`, `*Provider.js`) são ignorados porque ficam na raiz do app e acenderiam todas as features.
- Erros sem frame em `src/` (dentro de lib): `culprit = null`; só o card ativo fica vermelho e o painel avisa.
- Erros HTTP só entram se algum frame da chamada estiver em `src/` (descarta analytics, extensões etc.).

### Teste de ponta a ponta

Chrome headless contra o dev server, com a rede em modo offline (nada chega ao backend) e credenciais descartáveis na tela de login. O teste confere que a exceção é capturada com o arquivo e a função certos e o caminho de chamada, que a chamada HTTP aparece como `NetworkError` com o service que a fez como culpado, e que nenhuma credencial nem texto de erro vaza nas mensagens ao painel.

## Arquitetura (índice estático)

```
extension.js (extension host)
  ├─ detecta o proz-frontend (setting srcMap.projectRoot, env SRC_MAP_PROJECT_ROOT ou pasta do workspace)
  ├─ Worker (src/worker.js) → src/indexer.js  (parse com @babel/parser, cache por mtime)
  ├─ file watcher em src/**  → reindexa com debounce de 1,5 s
  └─ webview (public/)  ←postMessage→  { index | indexing | failed }  /  { ready | reindex | open | reveal }
```

- `src/parse.js` extrai só estrutura (imports, exports, JSX usado). Não guarda código-fonte.
- `src/resolve.js` resolve módulos (relativo, `@components/`, baseUrl `src`) e segue barrels (`export { default as X } from`, `export *`).
- `src/routes.js` lê `src/routes/**` (objetos com `component`/`path` e chamadas como `appRoute(ROUTE.X, Comp)`), resolvendo `ROUTE.*` a partir de `services/constants/routes/*`.
- `src/indexer.js` monta os cards, as árvores de pasta e as dependências (profundidade ≤ 4, só expande hooks/api/services/componentes).
- A extensão só abre arquivos dentro de `<projeto>/src`, validando o caminho vindo do webview.

## Limites conhecidos

- ~7% dos arquivos de `pages/` (156 de 2.241) não pertencem a nenhum card: aparecem só nas dependências de quem os importa e na busca por arquivo.
- Rotas montadas dinamicamente fora de `src/routes/**` não entram.
- `routePath` fica `null` quando a constante não é uma string estática (1 caso hoje); o card mostra `ROUTE.CHAVE`.
- O sourcemap do CRA em dev é `cheap-module-source-map` (linha, sem coluna): `arquivo:linha` é exato, a coluna não.
- Erros de render só são classificados como `render` pela pilha síncrona do React; promessas rejeitadas viram `rejection`.
- A captura começa quando o monitor anexa à aba (até 1,5 s): erros muito cedo no boot podem passar.
