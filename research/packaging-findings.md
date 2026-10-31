# Packaging findings: a third-party dsh 0.2.1-rc.5 plugin on top of Agent Teams

Scout: packaging-scout · 2026-10-31 · Read-only research. No user profile, dsh installation, or global state was modified.

**What was actually run:** every experiment used an isolated `DSH_HOME=/tmp/dsh-research/home`. A throwaway probe bundle lives at `/tmp/dsh-research/probe`; `/tmp/dsh-research/run-mock.mjs` is the mock-LLM driver and `/tmp/dsh-research/tscheck` is the typecheck scratch project. All of these are disposable.

Evidence abbreviations:
- `PKG/<name>` = `/tmp/dsh-research/pkgs/deepseek-ai-<name>-0.2.1-rc.5/`
- `APPBOOT` = `PKG/dsh-app-boot/lib/index.js`
- `PM` = `PKG/dsh-plugin-manager/lib/index.js`
- `PMOPS` = `PKG/dsh-plugin-manager/lib/types/operations.js`
- `RESOLVER` = `PKG/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`
- `MONO` = `/Users/rinai/project/self/deepseek-harness` (0.2.1-alpha.1 source, older than rc.5)

---

## TL;DR (key facts verified by experiment)

1. **The package must be a bundle.** It needs `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` plus a patch that `insert`s its own row.
   - The plugin page refuses a package that has no `dsh.bundle`.
   - `dsh plugin add` installs such a package only as an inactive plain dependency.
2. **Every `@deepseek-ai/*` package your code imports at runtime must be a `peerDependency`, never a `dependency`.** This is not optional: when the plugin is installed with `link:` (local dev), the dsh resolver serves a host package to the plugin *only if* the plugin's package.json lists that package in `peerDependencies`.
   - Verified: the probe failed with `ERR_MODULE_NOT_FOUND '@deepseek-ai/schemastery'` while only `@deepseek-ai/cordis` was a peer.
   - It loaded after adding the `schemastery` and `dsh-experimental-agent-team` peers.
3. **Declare `engines.dsh`.** When `engines.dsh` is present it alone decides compatibility. Without it, every `@deepseek-ai/dsh-*` peer range must match the running dsh version, or the bundle is skipped as "incompatible".
   - The user's profile logs already show this failure for `dsh-computer-use@0.2.0-rc.2`, which pins its peers exactly.
4. **`inject: ['agentTeams', ...]` is enough to depend on Agent Teams.**
   - With the Agent Teams bundle enabled, the probe applied with `ctx.agentTeams` live.
   - Without it, the probe stayed `pending (waiting for service: agentTeams)`. dsh printed a warning but did not crash.
5. **Local development works without publishing.**
   - `dsh plugin --profile <p> add /abs/path/to/repo` records `link:` and auto-enables the bundle.
   - `dsh plugin --profile <p> add /abs/path/x.tgz` records `file:` and also works.
   - The plugin page "add package" passes the same spec straight to `pnpm add`, but the path must be absolute.
6. **Published `.d.ts` files are usable.** A strict `NodeNext` project with `skipLibCheck: false` compiles against the rc.5 types, including the `ctx.agentTeams` declaration merge.
7. **A keyless end-to-end test is possible.** `@deepseek-ai/dsh-llm-mock-server@0.2.1-rc.5` is published, and `dsh-base` honours `DEEPSEEK_BASE_URL`. A real headless run with base + headless + agent-team-profile + our package booted, mounted our plugin, and printed the scripted answer (`MOCK DONE`, exit code 0).

---

## Q1. How a third-party npm package becomes a dsh plugin

### Bundles are the unit of installation

- A profile is `$DSH_HOME/profiles/<name>/` containing:
  - a `package.json` whose `dsh.profile.bundles` holds an ordered list;
  - the user's `cordis.patch.yml`.
- The Loader tree is built by applying patches over an empty root, in this order: each bundle's patch files (in list order), then the profile's own `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays.
- Evidence: APPBOOT:488-505 (module doc) and APPBOOT:1112-1137 (`readProfilePatches`).
- A bundle is any package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The `patch` value may be one file or an ordered list (APPBOOT:511-531).
- If a profile lists a package that has no `dsh.bundle`, that package is skipped: `"declares no dsh.bundle in its package.json"` (APPBOOT:1023-1024).

### Where bundle packages are resolved from

- The installation anchor is checked first, then the profile directory (APPBOOT:983-1001, `resolveBundleDir`).
- The Desktop installation anchor is `app.asar/dsh/package.json` (`@deepseek-ai/dsh-desktop-runtime`). It lists about 300 `@deepseek-ai/*` runtime packages as dependencies, including:
  - `dsh-experimental-agent-team`, `dsh-tools`, `schemastery`, `cordis`;
  - the optional bundle `dsh-experimental-agent-team-profile`.
- This explains why the user's desktop profile lists `@deepseek-ai/dsh-experimental-agent-team-profile` in `bundles` without listing it in `dependencies` (`~/.dsh/profiles/desktop/package.json`).
- `OPTIONAL_BUNDLES` includes it (APPBOOT:579-592).

### Plugin row

Our bundle's `cordis.patch.yml` must insert the row that loads the package:

```yaml
- insert:
    - id: dsh-agent-team-scheduler
      name: dsh-agent-team-scheduler
      config: {}
```

`name` is resolved like an import specifier, so it loads our `exports["."]`.

Real-world examples of the same layout:
- `kivotos/cordis.patch.yml`
- `dsh-pet/cordis.patch.yml`
- `dsh-omp-retry/cordis.patch.yml` (all under `~/.dsh/profiles/desktop/node_modules/`)
- the official `PKG/dsh-experimental-agent-team-profile/cordis.patch.yml`

The dsh-pet comments note a market convention: the row `id` should equal the package name and must not carry an end-of-line comment. Its market precheck uses a regex on that line (`dsh-pet/cordis.patch.yml` header comments).

### Plugin module surface (Cordis plugin)

The module exports `name`, `inject`, `Config` (a schemastery schema), and `apply(ctx, config)`. A `Service` subclass is also accepted.
- Example: `PKG/dsh-experimental-tool-agent-team/lib/index.js:7-20,556`, which exports `name = "tool-agent-team"`, `inject = ["agents","agentTeams","tools","systemPrompt"]`, `Config`, and `apply`.
- Its types are in `PKG/dsh-experimental-tool-agent-team/lib/types/index.d.ts`.

### Compatibility gate (load time and install time)

`evaluatePluginCompatibility` (APPBOOT:252-326):
- If `engines.dsh` is present, it alone decides.
- Otherwise every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range must be satisfied by the runtime version, with `includePrerelease`.
- Peers outside that pattern, such as `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`, are ignored.
- An incompatible bundle is skipped at load (APPBOOT:1025-1026).
- An incompatible install is refused unless an exact-version exemption exists (`dsh plugin allow-version`, PM:2075-2076, MONO apps/cli/src/plugin.ts:17-62).

Recommendation: set `"engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" }` (or tighter). Keep `engines.node` as a separate key.

### Plugin page display (meta)

Display metadata is read without running plugin code by `readPluginMeta` (APPBOOT:2199-2248):
- **Title and description** come from `<pkg>/locale/<lang>.json` files containing `{"meta":{"title","description"}}`, resolved through package exports. So `exports` must contain `"./locale/*.json": "./locale/*.json"`. File names must be language ids (`en.json`, `zh.json`). Fallback is package.json `name` / `description` (APPBOOT:2168-2198, 2220-2225).
- **package.json must be exported** (`"./package.json": "./package.json"`) for the name/description fallback and the icon to be read (APPBOOT:2222).
- **Icon** comes from package.json `"icon": "./icon.svg"`, a relative path that must stay inside the package. Allowed formats are SVG/PNG/JPEG/WebP, up to 256 KiB, inlined as a data URL. If there is no `icon` field, dsh falls back to an `exports["./icon"]` resource (APPBOOT:2073-2111).
  - Examples: the official profile uses `"icon": "./icon.svg"` (`PKG/dsh-experimental-agent-team-profile/package.json`); kivotos uses `exports["./icon"]`.
- Locale text for tool names and descriptions at runtime is a separate concern and not needed for the page.

### Optional market metadata (UNVERIFIED for rc.5)

- dsh-pet declares `dsh.compatibility.dshReleases: { "<ver>": "compatible" }`. Its comments say the DSH STORE market requires at least one of the latest three releases to be marked compatible.
- This field is not read by app-boot's loader; it only matters for a market listing.
- The `keywords` used by peers are `"deepseek-harness","dsh","dsh-plugin"`.

## Q2. Installing into the Desktop and Web profiles

### Where profiles live

- Profiles are at `~/.dsh/profiles/{desktop,web,dsh-tui}`. The user's Desktop profile is `~/.dsh/profiles/desktop`.
- Its `package.json` currently has bundles: base, web-app, kivotos, auto-review, plugin-market, session-search, badge-skill, `dsh-omp-retry`, `@xmanrui/dsh-im`, `dsh-pet`, `@deepseek-ai/dsh-experimental-agent-team-profile`.
- It also sets `"patchReload": "live"`.
- **Precedent:** the user already develops `dsh-omp-retry` as `"dsh-omp-retry": "link:/Users/rinai/project/dsh-omp-retry"`.
- `pnpm-workspace.yaml` in a profile sets `nodeLinker: hoisted` and `autoInstallPeers: false` (APPBOOT:598-603). So peers are **not** installed into the profile, which is exactly what we want.
- The Web GUI on `http://127.0.0.1:50602` is served by the Desktop app, so it uses the **desktop** profile (UNVERIFIED but consistent).
- `~/.dsh/profiles/web` is a separate, minimal profile (bundles: base and web-app only) used by `dsh web`.

### Plugin page "add package" (Web GUI / Desktop)

- `installBundle(spec)` runs `pnpm add <spec>` with the bundled pnpm (PM:1959-2094).
- It then requires exactly one changed dependency that declares `dsh.bundle`. A failure or a non-bundle triggers `not-bundle`, and `package.json`/lockfile are restored (PM:2063-2077, 2081).
- On success it selects the bundle and live-reloads (PM:2090-2094).
- Accepted spec forms (`parseInstallSpec`, PM:60-101; `install-spec.d.ts`):
  - a registry name;
  - an **absolute** local directory (relative paths are refused: "a local path must be absolute");
  - a local or HTTP tarball;
  - git (github:, gitlab:, …).
- A pre-check (`inspect`) refuses a path or registry package that declares no `dsh.bundle`, or that is already installed (PM:1855-1918).

### CLI: `dsh plugin --profile <p> <pnpm args>`

- The command is a raw pnpm passthrough plus `allow-version`, `revoke-version`, and `version-exemptions` (MONO apps/cli/src/plugin.ts).
- Relative `file:` and `link:` specs are anchored to the caller's cwd (PMOPS:66-76).
- After `add`, `reconcile()` appends new bundle packages to `dsh.profile.bundles`. A non-bundle gets the warning "installed as a plain dependency, not a profile layer" (PMOPS:96-124, 559).
- **Desktop profile:** the CLI refuses unless the profile exists. Its message says *"fully quit it before running dsh plugin --profile desktop"* (MONO plugin.ts:10-13, 92-96).
  - So for the desktop profile, prefer the plugin page while Desktop is running, or quit Desktop before using the CLI.

### Verified local install forms (isolated DSH_HOME, dsh 0.2.1-rc.5 bundled CLI, pnpm 11.28.5)

```sh
D="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-research/home "$D" plugin --profile probe add /tmp/dsh-research/probe
#  → "dsh-probe-plugin": "link:/tmp/dsh-research/probe"; bundles += "dsh-probe-plugin"
DSH_HOME=/tmp/dsh-research/home "$D" plugin --profile probe2 add /tmp/dsh-research/dsh-probe-plugin-0.0.1.tgz
#  → "dsh-probe-plugin": "file:/tmp/dsh-research/dsh-probe-plugin-0.0.1.tgz"; bundles += it
```

- Both forms mounted and applied in a headless run (see Q6).
- `link:` prints a pnpm warning that linked deps do not resolve peers from the target. This is harmless because dsh's resolver supplies them, **as long as they are declared as peers** (see Q4).
- Use `link:` for the edit → rebuild loop: dsh imports `lib/` directly from the repo. On the desktop profile (`patchReload: live`), toggle the plugin or restart Desktop to pick up a new build.
  - UNVERIFIED whether Desktop hot-reloads built JS of a linked bundle. The plugin-manager HMR path exists for client bundles only when the `dev:web` watcher runs.

## Q3. Depending on the Agent Teams bundle; load order; bundle vs plugin

- **Services provided by the Agent Teams pieces:**
  - `@deepseek-ai/dsh-experimental-agent-team` provides `ctx.agentTeams` (`TeamService`). Its own injects are `agents`, `sessions`, `sessionPersistence`, `sessionProjections`, `subagents` (`PKG/dsh-experimental-agent-team/lib/index.js:1430-1452`; d.ts `declare module '@deepseek-ai/cordis' { interface Context { agentTeams: TeamService } }` at `lib/types/index.d.ts:12-16`).
  - `tool-agent-team` registers the Team tools and injects `agents`, `agentTeams`, `tools`, `systemPrompt`.
- **Load order is driven by `inject`, not by row order.** A plugin with `inject: ['agentTeams', 'tools', 'agents']` stays pending until those services exist, and unloads if they go away.
  - Verified with `dsh headless` (probe2 without the agent-team bundle): `dsh: warning: 1 entry did not activate — dsh-probe-plugin: pending (waiting for service: agentTeams)`. Exit code 0.
  - With the bundle enabled: `apply hello agentTeams=function tools=object TeamTaskId=function`.
  - Use `inject: { required: [...], optional: [...] }` (Cordis 4 object form) if some services are optional. UNVERIFIED in this run; see `PKG/cordis` / MONO docs/cordis-primer.md.
- **Recommendation: ship a plain bundle next to the agent-team profile, not a bundle that re-inserts its rows.**
  - Our patch should only `insert` our own row.
  - Re-inserting `agent-team` / `tool-agent-team` rows would duplicate ids when the user also enables `@deepseek-ai/dsh-experimental-agent-team-profile`. That bundle is already enabled on the user's desktop profile.
  - Bundle order in `dsh.profile.bundles` only matters for patch targeting (id-targeted overrides or disables of rows inserted by earlier layers). The plugin page appends new bundles at the end (APPBOOT:1217, PMOPS:116-118), i.e. after agent-team-profile, which is what we want if we ever need to override its rows.
- Document "enable Agent Teams (Experimental) in the plugin page" as a prerequisite. Our plugin will just show as pending if it is not enabled.
- Do **not** list `@deepseek-ai/dsh-experimental-agent-team-profile` as an npm dependency. It ships inside the installation as an optional bundle.

## Q4. Dependencies, types, and module resolution

### Runtime resolution rule (critical)

Evidence: RESOLVER:121-129 (`findInterceptionLayer`), RESOLVER:397-459 (`routeScoped`), RESOLVER:460-514 (`routeLinked`), RESOLVER:131-138 (`readPeerNames`).

- **A plugin installed into profile `node_modules` (registry install or `file:` tgz):**
  - a bare import is first looked up in the profile's own `node_modules`;
  - otherwise it is intercepted to the installation's copy (for example `app.asar/dsh/node_modules/@deepseek-ai/...`).
  - Never ship `@deepseek-ai/*` as `dependencies`. A local copy would win over interception and give two Cordis instances or two service classes.
- **A plugin linked from outside the profile (`link:`):** a bare import is intercepted only if an ancestor package.json lists the name in **`peerDependencies`**. Otherwise Node's native resolution runs from the repo directory.
  - The peer check is done before the local `node_modules` candidate in the same directory. So devDependency copies installed in the repo for tsc/tests do **not** shadow the host copies at runtime.
  - Verified by experiment (Q-TLDR #2).

### Which packages to declare

**peerDependencies** — everything imported at runtime that the host provides:
- `@deepseek-ai/cordis` `~4.0.5` (the runtime value `Context`/`Service` if used; types-only imports still benefit from the declaration);
- `@deepseek-ai/schemastery` `~3.18.5` (Config schema);
- `@deepseek-ai/dsh-experimental-agent-team` (`TeamTaskId`, `TeamError`, types);
- `@deepseek-ai/dsh-tools` (`defineTool`);
- `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-system-prompt`, only if imported.
- Version ranges for `@deepseek-ai/dsh-*` peers: use `>=0.2.1-rc.5 <0.3.0`.
  - With `engines.dsh` present, app-boot ignores these ranges for compatibility. They still drive npm/pnpm peer warnings.
  - Exact `0.2.1-rc.5` pins would break on rc.6 if `engines.dsh` were ever removed.
  - Note the npm dist-tags: `@deepseek-ai/dsh-experimental-agent-team` has `latest: 0.1.5-alpha.2`, `next: 0.2.1-rc.5`, `alpha: 0.2.2-alpha.2`. **Never rely on `latest`.**
  - `@deepseek-ai/cordis` `latest` is 4.0.5.

**devDependencies** — the same packages pinned exactly at `0.2.1-rc.5` (`4.0.5` / `3.18.5` for cordis / schemastery), plus `typescript`, `@types/node`, and the test tooling.
- `npm install` of these pulled 27 `@deepseek-ai/*` packages transitively (`/tmp/dsh-research/tscheck/node_modules/@deepseek-ai`).

### Types

- Published packages ship `lib/types/**/*.d.ts` with `exports["."].types` (for example `PKG/dsh-experimental-agent-team/package.json` exports `.`, `./client`, `./types`).
- The d.ts files import siblings with `.ts` extensions (`from './types.ts'`). These resolve fine.
- **Verified:** `/tmp/dsh-research/tscheck` (TS 5.9, `module`/`moduleResolution: NodeNext`, `strict`, `verbatimModuleSyntax`, `skipLibCheck: false`) compiled a plugin using `ctx.agentTeams.listTasks(agent)`, `TeamTaskId`, the `z<Config>` schema, and `Agent` from `dsh-agent`, with exit code 0.
- **ESM only:** every dsh package is `"type": "module"`, and the dsh CLI imports plugin modules with ESM resolution. Use `NodeNext`. Node engines in dsh: `^22.19 || >=24`. Desktop's bundled Node is 24.21.0 (`Resources/runtime/versions.json`).

## Q5. Build expectations

- dsh imports the module resolved from `exports["."]` of the row `name` (via `loader.internal.resolveSync`; same resolver as the meta reader, APPBOOT:2120-2134). So ship built JS in `lib/` and point `exports["."]` at it.
  - TypeScript source is not loaded; Node's TS stripping is not relied on (MONO AGENTS.md "Conventions").
- **Build tool:** plain `tsc` emitting `lib/` (JS + d.ts) is sufficient for a host-only plugin because peers are not bundled.
  - Official packages use `tsc` for types plus tsdown for bundling.
  - dsh-pet uses tsdown; kivotos uses esbuild.
  - Recommendation: `tsc -p tsconfig.build.json` for v1. Add tsdown later only if a client bundle is needed.
- **Client (browser) UI, optional and low priority:**
  - Declare `"dsh": { "client": { "platform": "web", "inject": [...], "immediately"?: bool } }` and export the built browser bundle at `exports["./client"]`.
  - The `dsh-client-modules` service scans enabled Loader rows whose specifier is the bare package name and serves `/plugins/??<pkg>/client.js` (MONO docs/subsystems/client-modules.md:80-88; docs/cookbook/adding-a-settings-card.md:58-68).
  - Example manifests: `kivotos` and `dsh-pet` package.json. Skip for v1.

## Q6. Testing outside the monorepo

### (a) Unit tests with fake `ctx`

- The fastest option: test pure scheduling logic plus an `apply(ctx)` that receives a stub `{ agentTeams, tools, logger, on, effect }`. The user's `dsh-omp-retry` uses `node --test` with fakes (`/Users/rinai/project/dsh-omp-retry/test/plugin.test.mjs`).
- Keep the domain logic in functions that take a narrow interface, e.g. `Pick<TeamService, 'listTasks' | 'updateTask' | 'sendMessage'>`.

### (b) Real Cordis composition in-process (vitest)

All of these are published at 0.2.1-rc.5 (verified with `npm view`):
- `@deepseek-ai/dsh-agent-loop-testkit`
- `dsh-agent-loop`
- `dsh-session-persistence-jsonl`
- `dsh-session-query`
- `dsh-subagent`
- `dsh-subagent-spawn-in-process`
- `dsh-subagent-fork-in-process`
- `dsh-experimental-agent-team`

The official Team tests mount them like this (MONO packages/experimental/agent-team/tests/team.spec.ts:56-77):

```ts
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)              // from dsh-agent-loop-testkit
await ctx.plugin(JsonlSessionPersistence, { root: tmpdir })
await ctx.plugin(TestSessionQuery)                     // test-local subclass of SessionQueryEngine (copy ~60 lines from MONO tests/test-session-query.ts)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentService)
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(SubagentFork, { providerName: 'fork' })
await ctx.plugin(TeamService, {})
await ctx.plugin(OurPlugin, {...})
ctx.llm.registerAdapter(['mock'], new MockAdapter(script)) // MockAdapter is NOT published: copy MONO packages/core/agent-loop/tests/mock-adapter.ts (139 lines, extends LlmAdapter from dsh-llm)
const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
```

- `@deepseek-ai/dsh-test-support` does **not** exist on npm (404).
- `@deepseek-ai/dsh-llm-replay` is published: it replays recorded session JSONL fixtures, which suits snapshot tests later.
- Caveat: these tests import devDependency copies. Ensure exactly one `@deepseek-ai/cordis` resolves in `node_modules` (npm dedupes; check with `npm ls @deepseek-ai/cordis`).

### (c) Real headless dsh plus the mock LLM server (keyless end-to-end) — **VERIFIED**

`@deepseek-ai/dsh-llm-mock-server` exports `startMockLlmServer({ sequence, repeatLast, toolName, toolArguments, successText, apiKey })` (`PKG/dsh-llm-mock-server/lib/types/index.d.ts`). It speaks Anthropic Messages at `<baseURL>/v1/messages`.

Recipe (what `/tmp/dsh-research/run-mock.mjs` does):

```sh
export DSH_HOME="$(mktemp -d)"            # isolated; never touches ~/.dsh
D="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # or `dsh` on PATH / in CI
"$D" plugin --profile e2e add "$PWD"       # link: ; auto-enables our bundle; profile initialized with dsh-base
# set bundle order (custom profile name; 'headless' itself is installation-owned and normalized):
node -e 'const f=process.env.DSH_HOME+"/profiles/e2e/package.json",fs=require("fs"),m=JSON.parse(fs.readFileSync(f));m.dsh.profile.bundles=["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","@deepseek-ai/dsh-experimental-agent-team-profile","dsh-agent-team-scheduler"];fs.writeFileSync(f,JSON.stringify(m,null,2))'
"$D" --profile e2e --dump-config | grep -A3 dsh-agent-team-scheduler     # composition check
# then from a node test: start mock server and spawn
#   DEEPSEEK_BASE_URL=<server.baseURL>/v1 DEEPSEEK_API_KEY=mock-key DSH_TELEMETRY_DISABLED=1 "$D" --profile e2e [--json] "task"
```

Results of running it:
- `--dump-config` showed the `# == dsh-probe-plugin` layer after `# == @deepseek-ai/dsh-experimental-agent-team-profile`.
- The headless run exited with code 0 and stdout `MOCK DONE`.
- The probe's `apply` saw `ctx.agentTeams`.
- The first request's tools included `spawn_teammate`, `team_task_*`, `send_message`, `wait_agent`, `list_agents`, `interrupt_agent`.

Notes:
- Use `repeatLast: true`. dsh makes extra requests after the main answer (3 requests for a one-turn task), and without `repeatLast` it fails with "mock script exhausted".
- `--json` prints NDJSON run events, which are good for assertions.

## Q7. Installed dsh CLI and running headless

- `/usr/local/bin/dsh` does **not** exist, and `which dsh` finds nothing. Desktop's "Manage dsh Command…" has not been used.
- The bundled launcher works directly: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`.
  - `--version` prints `0.2.1-rc.5`.
  - It runs `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness" --expose-internals app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`.
  - It uses the bundled pnpm 11.28.5 (`runtime/primary-runtime/runtime.json`; `dsh-desktop-host/lib/cli.js` `runDesktopCli`).
- Headless usage: `dsh --profile <p> [--json] [--session-id <id>] "task"` (stdin with `-`), per `dsh --profile headless --help`.
- To run against a profile with Agent Teams plus our local package without touching the desktop profile, use the Q6(c) recipe with a real `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`).
  - Reusing the user's GLM gateway config requires copying the `llm-pi-ai` / `agent-default-model` rows from `~/.dsh/profiles/desktop/cordis.patch.yml` into the test profile's `cordis.patch.yml`.
- In CI, install the CLI with `npm i -g @deepseek-ai/dsh@0.2.1-rc.5` (published, verified with `npm view`). Its bin is `dsh`.
  - UNVERIFIED that the npm CLI carries `dsh-experimental-agent-team-profile` as an installation dependency. If not, add it to the test profile: `dsh plugin --profile e2e add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.5`.

## Q8. Publishing

- **Name:** `dsh-agent-team-scheduler` is free (`npm view` → E404). Unscoped is fine; kivotos, dsh-pet, and dsh-omp-retry are unscoped.
- **`files`:** `lib`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `README.md`, `LICENSE`. Also export `./package.json`, `./locale/*.json`, and `./cordis.patch.yml`.
- **Avoid a `prepare` script for build.** pnpm 11 blocks install scripts of dependencies until approved (dsh-pet comment; MONO plugin.ts:103-105). Build in `prepack` / CI instead and publish the built `lib/`.
- **Required conventions for the plugin page:**
  - `icon` (≤256 KiB svg/png/jpg/webp inside the package);
  - `locale/en.json` and `locale/zh.json` with `meta.title` / `meta.description`;
  - `description`;
  - keywords `dsh`, `dsh-plugin`, `deepseek-harness`.
- **Provenance:** use `npm publish --provenance --access public` with `id-token: write`. kivotos sets `publishConfig.provenance: true`.
- **Versioning:** declare `engines.dsh` per supported release range. Bump it when dsh breaks the APIs we use; for experimental Agent Teams, expect breakage per rc.

---

## Recommended setup

### package.json

```json
{
  "name": "dsh-agent-team-scheduler",
  "version": "0.1.0",
  "description": "Scheduler for DeepSeek Harness Agent Teams: drives the shared Team task board automatically.",
  "license": "MIT",
  "author": "Rinai-R",
  "repository": { "type": "git", "url": "git+https://github.com/Rinai-R/dsh-agent-team-scheduler.git" },
  "homepage": "https://github.com/Rinai-R/dsh-agent-team-scheduler#readme",
  "bugs": { "url": "https://github.com/Rinai-R/dsh-agent-team-scheduler/issues" },
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "agent-teams", "scheduler"],
  "type": "module",
  "icon": "./icon.svg",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "LICENSE"],
  "engines": { "node": "^22.19.0 || >=24", "dsh": ">=0.2.1-rc.5 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "prepack": "npm run build"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/schemastery": "~3.18.5",
    "@deepseek-ai/dsh-agent": ">=0.2.1-rc.5 <0.3.0",
    "@deepseek-ai/dsh-experimental-agent-team": ">=0.2.1-rc.5 <0.3.0",
    "@deepseek-ai/dsh-session": ">=0.2.1-rc.5 <0.3.0",
    "@deepseek-ai/dsh-tools": ">=0.2.1-rc.5 <0.3.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/schemastery": "3.18.5",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.5",
    "@deepseek-ai/dsh-agent-loop": "0.2.1-rc.5",
    "@deepseek-ai/dsh-agent-loop-testkit": "0.2.1-rc.5",
    "@deepseek-ai/dsh-experimental-agent-team": "0.2.1-rc.5",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.5",
    "@deepseek-ai/dsh-llm-mock-server": "0.2.1-rc.5",
    "@deepseek-ai/dsh-session": "0.2.1-rc.5",
    "@deepseek-ai/dsh-session-persistence-jsonl": "0.2.1-rc.5",
    "@deepseek-ai/dsh-session-query": "0.2.1-rc.5",
    "@deepseek-ai/dsh-subagent": "0.2.1-rc.5",
    "@deepseek-ai/dsh-subagent-fork-in-process": "0.2.1-rc.5",
    "@deepseek-ai/dsh-subagent-spawn-in-process": "0.2.1-rc.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.5",
    "@types/node": "^22.19.0",
    "typescript": "~5.9.3",
    "vitest": "^3.2.0"
  }
}
```

- Add any other `@deepseek-ai/dsh-*` package to **both** `peerDependencies` (range) and `devDependencies` (exact) the moment `src/` imports it at runtime. Missing peers break `link:` installs (verified).
- `peerDependenciesMeta` is not needed; the profile has `autoInstallPeers: false`.

### cordis.patch.yml, locale, icon

```yaml
# Bundle layer: mount the scheduler after (and independent of) the Agent Teams bundle.
# The plugin injects agentTeams/tools and stays pending until Agent Teams is enabled.
- insert:
    - id: dsh-agent-team-scheduler
      name: dsh-agent-team-scheduler
      config: {}
```

The locale files:
- `locale/en.json`: `{"meta":{"title":"Agent Team Scheduler","description":"…"}}`
- `locale/zh.json`: the same with Chinese text.

`icon.svg` must be ≤256 KiB.

### tsconfig.json (typecheck: src plus tests) and tsconfig.build.json

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": false,
    "types": ["node"],
    "outDir": "lib",
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib", "noEmit": false },
  "include": ["src"]
}
```

- `skipLibCheck: false` passed against the rc.5 types (verified).
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` were not exercised in the scratch check. Drop them if the rc.5 d.ts trip them.

### Build tool

Use `tsc` only, emitting ESM JS + d.ts into `lib/`. Nothing is bundled, since every `@deepseek-ai/*` import is a host peer. Revisit tsdown only when a `./client` UI is added.

### Test strategy

1. **Unit (vitest):** pure scheduler logic plus `apply()` against a fake `ctx`.
2. **Integration (vitest):** a real Cordis `Context` with `mountAgentLoopTestDependencies` + JSONL persistence + subagent spawn/fork + `TeamService` + our plugin, using a copied `MockAdapter` and `TestSessionQuery` (Q6b). Assert board/tool effects through `ctx.agentTeams`.
3. **End-to-end (keyless):** `npm run build`, then an isolated `DSH_HOME` profile `e2e` with bundles `[dsh-base, dsh-headless, dsh-experimental-agent-team-profile, dsh-agent-team-scheduler]` (link: install). Run `dsh --profile e2e --json "…"` against `startMockLlmServer({ sequence: [...tool calls..., 'success'], repeatLast: true })`. Assert our plugin activated (no "did not activate" on stderr), plus NDJSON events.
4. **Manual (real model):** link into the desktop profile (below).

### Local dev install commands

```sh
cd ~/project/self/dsh-agent-team-scheduler && npm ci && npm run build
D="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # or install /usr/local/bin/dsh via Desktop › Manage dsh Command…

# Option A — Desktop/Web GUI: Plugins page › Add package › paste the ABSOLUTE path
#   /Users/rinai/project/self/dsh-agent-team-scheduler     (records link:, enables the bundle, live reload)
# Also make sure "Agent Teams (Experimental)" is enabled (already true on this machine).

# Option B — CLI into the desktop profile (fully quit Desktop first):
"$D" plugin --profile desktop add /Users/rinai/project/self/dsh-agent-team-scheduler

# Option C — throwaway profile, never touching ~/.dsh:
export DSH_HOME=/tmp/dsh-sched-home
"$D" plugin --profile sched add "$PWD"     # then set bundles as in Q6(c)
"$D" --profile sched --dump-config | grep -A3 dsh-agent-team-scheduler

# Tarball rehearsal of the published artifact:
npm pack && "$D" plugin --profile sched add "$PWD/dsh-agent-team-scheduler-0.1.0.tgz"
# Remove: "$D" plugin --profile <p> remove dsh-agent-team-scheduler
```

After editing: `npm run build`, then toggle the plugin off/on in the plugin page or restart Desktop. Whether live reload re-imports changed JS of a linked package is UNVERIFIED.

### GitHub Actions: `.github/workflows/publish.yml`

```yaml
name: ci-publish
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
      # Keyless E2E against the published dsh CLI (no model key needed: mock LLM server)
      - run: npm i -g @deepseek-ai/dsh@0.2.1-rc.5
      - run: npm run test:e2e
        env:
          DSH_TELEMETRY_DISABLED: '1'
      - run: npm pack --dry-run

  publish:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write          # npm provenance
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - name: Verify tag matches package.json version
        run: test "v$(node -p 'require(\"./package.json\").version')" = "${GITHUB_REF_NAME}"
      - run: npm run build
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- For a prerelease such as `0.1.0-rc.1`, add `--tag next` so it does not take `latest`.
- The e2e step's assumption that the npm `@deepseek-ai/dsh` CLI carries the agent-team-profile bundle is UNVERIFIED (see Q7). If it does not, the e2e setup script should `dsh plugin --profile e2e add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.5`.

## Open items / caveats

- MONO is 0.2.1-alpha.1 source. Every rc.5 claim above was checked against the published rc.5 `lib/` or by experiment, unless marked UNVERIFIED.
- Hot-reload of host JS for a linked bundle in Desktop was not tested.
- `dsh plugin --profile desktop` requires Desktop to be quit. Not tested, to avoid touching the user's profile.
