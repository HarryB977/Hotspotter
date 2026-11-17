# v0.1-D: portable `.exe` and update notices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Hotspotter as a portable Windows folder with `hotspotter.exe`, which needs no Node installed and is built and released by a GitHub Action when a semver tag is pushed. Add an update notice that tells colleagues about new stable versions.

**Architecture:**
- The Fastify server gains a runtime config: the real port, an injected version, a data dir and an update checker. A new launcher entry picks the port, detects a running copy, opens Chrome or Edge and prints the Spanish console text.
- A build script bundles the launcher with esbuild into one CommonJS file, turns it into a Node Single Executable Application, and places the built frontend next to it.
- A tag-triggered workflow tests, builds, injects the optional read-only token and publishes the zip with the CHANGELOG notes.

**Tech Stack:** Node 22, TypeScript, Fastify 5, esbuild, postject (Node SEA), Vitest, React 18, Playwright, GitHub Actions (windows-latest).

**Spec:** `docs/superpowers/specs/2026-11-17-v01d-portable-y-actualizaciones-design.md` (approved 2026-11-17), refining `docs/08-distribution.md`.

## Global Constraints

- The server listens only on `127.0.0.1`. The Host and Origin checks stay and use the **real** port. The `X-Hotspotter: 1` header is required on every state-changing request.
- The token never appears in the repo, in a log, in the Action output, or in any server response to the browser. If no token is provided, the build still works and the update check runs unauthenticated.
- User data lives in `%LOCALAPPDATA%\Hotspotter`, never next to the `.exe`. The env var `HOTSPOTTER_DATA_DIR` overrides it, for tests.
- The preferred port is `7420`, with any free port as fallback. Update checks run at most once every **6 hours**, cover **stable releases only**, and are **off in dev**.
- Repository: `HarryB977/Hotspotter`. Tags look like `vX.Y.Z`. A tag with a `-` is published as a GitHub pre-release and never offered by the app.
- Text the user sees is in Spanish; code and comments are in English. New decisions start at **#90** in `docs/09-decisions.md`.
- New dependencies are exact pinned devDependencies only (`esbuild`, `postject`), at versions at least two weeks old. No runtime dependency beyond what the server already has.
- `samples/` is never committed. The ProBuilder extension is never touched.

## Review Focus

1. Port 7420 taken by something that is not Hotspotter: the launcher picks another port, says so in the console, and Host/Origin checks accept that port (Task 1 and Task 4 tests).
2. GitHub returns 401 or 403: the UI shows the auth line, and a network error shows nothing (Task 2 and Task 3 tests).
3. The latest release is older than or equal to the local version, or was skipped: no notice (Task 2 test).
4. A second copy with a different version: the console message, and no browser opens to the old one (Task 4 test).
5. The token is set: `/api/update` never echoes it, and the packaged bundle is the only place it exists (Task 2 test, Task 5 workflow log masking).

---

### Task 1: Server runtime config (port, version, data dir)

**Files:**
- Create: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/main.ts`
- Test: `apps/server/test/app.test.ts` (new), `apps/server/test/config.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// config.ts
export function dataDir(env?: NodeJS.ProcessEnv): string;   // HOTSPOTTER_DATA_DIR ?? %LOCALAPPDATA%\Hotspotter; created on demand by callers
export const APP_VERSION: string;                             // build-time define __HOTSPOTTER_VERSION__ when present, else apps/server/package.json version
// app.ts
export function buildApp(opts: { webRoot?: string; port: number; version?: string; dev?: boolean;
  updates?: UpdateService /* Task 2 */ }): FastifyInstance;
export function allowedOrigins(port: number, dev: boolean): Set<string>;  // http://127.0.0.1:<port>, http://localhost:<port>, plus :5173 ones when dev
```

- [ ] **Step 1: Write the failing tests.**
  - `buildApp({ port: 7421 })` accepts Host `127.0.0.1:7421` and rejects Host `127.0.0.1:7420`.
  - Origin `http://localhost:7421` is accepted and `http://127.0.0.1:5173` is rejected when `dev` is false. Both 5173 origins are accepted when `dev` is true.
  - `/api/health` returns `{ ok: true, version }` with the injected version.
  - `dataDir({ HOTSPOTTER_DATA_DIR: 'X:\\d' })` is `'X:\\d'`. `dataDir({ LOCALAPPDATA: 'C:\\L' })` is `'C:\\L\\Hotspotter'`.
- [ ] **Step 2:** Run `npm test -w @hotspotter/server`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - `APP_VERSION` must not read `package.json` through `import.meta.url` at runtime once bundled. Use the esbuild define, and keep the file read only as the dev fallback.
  - `main.ts` (dev) passes `dev: true` and port 7420.
  - The existing exportRoute tests still pass.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): runtime port, version and data dir`.

### Task 2: Update checker and API (server)

**Files:**
- Create: `apps/server/src/updates.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/updates.test.ts`

**Interfaces:**
- Consumes: `dataDir`, `APP_VERSION` (Task 1).
- Produces:

```ts
export type UpdateState =
  | { status: 'none' }
  | { status: 'available'; version: string; notes: string; url: string }
  | { status: 'authError' };
export interface UpdateService { state(): Promise<UpdateState>; skip(version: string): Promise<void> }
export function createUpdateService(o: {
  currentVersion: string; token?: string; dir: string;
  fetch?: typeof fetch; now?: () => number; repo?: string /* default 'HarryB977/Hotspotter' */;
}): UpdateService;
export function compareSemver(a: string, b: string): number;   // stable x.y.z only; leading 'v' allowed
```

**Behaviour:**
- **Request:** `GET https://api.github.com/repos/<repo>/releases/latest` with `Accept: application/vnd.github+json`, `User-Agent: Hotspotter/<version>`, and `Authorization: Bearer <token>` only when a token is set.
- **Throttle:** at most once per 6 h. `lastCheck` and the last result are persisted in `<dir>/updates.json`, together with `skipped: string[]`.
- **Result:**
  - `available` only when the tag is a stable semver greater than `currentVersion` and not skipped.
  - `authError` on HTTP 401 or 403.
  - Everything else, network errors included, gives `none` and is logged.
  - The body's `body` field is `notes` and `html_url` is `url`.
- **Routes:**
  - `GET /api/update` returns `UpdateState`. It is registered only when `updates` is passed to `buildApp`.
  - `POST /api/update/skip` takes `{ version }`, requires `X-Hotspotter: 1`, and returns 204.
- **Dev:** `main.ts` (dev) never passes `updates`.

- [ ] **Step 1: Write the failing tests** with an injected `fetch` and `now`.
  - Newer stable gives `available` with notes and url.
  - Equal and older give `none`.
  - The pre-release tag `v0.2.0-beta.1` gives `none`.
  - A skipped version gives `none`.
  - 401 and 403 give `authError`.
  - A thrown fetch gives `none`.
  - A second call within 6 h makes no fetch. A call after 6 h fetches again.
  - With a token, the request carries `Authorization`. The JSON of `/api/update` (through `app.inject`) never contains the token string.
  - `POST /api/update/skip` without the header gives 403.
  - `compareSemver('0.1.10','0.1.9') > 0`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Use Node's global `fetch`; add no dependency.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): update check against github releases`.

### Task 3: Update notice in the UI

**Files:**
- Create: `apps/web/src/update/UpdateNotice.tsx`
- Modify: `apps/web/src/App.tsx` (footer), `apps/web/src/i18n/es.ts`, `docs/05-ui.md`
- Test: `apps/web/e2e/update.spec.ts` (new)

**Interfaces:**
- Consumes: `GET /api/update` and `POST /api/update/skip` (Task 2). In dev the route doesn't exist (404). Treat 404 and any error as `none`.
- Produces: a compact notice at the right of the footer status bar.
  - `available`: «Hotspotter <v> disponible» plus «Notas», «Descargar», «Más tarde» and «Omitir esta versión».
    - «Notas» is a popover with the plain-text release notes. Don't render the markdown as HTML.
    - «Descargar» opens `url` in a new tab with `noopener`.
    - «Más tarde» hides the notice until the next app load.
    - «Omitir esta versión» calls skip and hides the notice.
  - `authError`: one muted line, «No se pueden comprobar actualizaciones; pide la versión nueva», with a dismiss ×.
  - `none`: nothing.
  - The page never scrolls and the footer keeps one row (ui.spec at 1366×700 still passes).

- [ ] **Step 1: Write the failing e2e tests.** Mock `/api/update` with `page.route`.
  - `available` shows the version and the four controls. «Descargar» opens a popup with the url.
  - «Omitir esta versión» sends a POST with `X-Hotspotter: 1` and the version, and hides the notice.
  - «Más tarde» hides the notice, and it comes back after a reload.
  - `authError` shows the Spanish line.
  - A 404 shows nothing.
  - Notes containing `<script>` render as text.
- [ ] **Step 2:** Run `npx playwright test e2e/update --workers=1` from apps/web. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx playwright test e2e/update e2e/ui --workers=1`. Expected: PASS.
- [ ] **Step 5:** Update docs/05-ui.md (the notice). Commit `feat(web): update notice in the status bar`.

### Task 4: Launcher and portable build

**Files:**
- Create: `apps/server/src/launcher.ts`, `apps/server/src/browser.ts`, `apps/server/src/instance.ts`, `scripts/build-portable.mjs`
- Modify: root `package.json` (script `portable`; pinned devDeps `esbuild`, `postject`), `.gitignore` (`dist/` already there; keep `dist/portable` ignored)
- Test: `apps/server/test/instance.test.ts`, `apps/server/test/browser.test.ts`, `scripts/smoke-portable.mjs`

**Interfaces:**
- Consumes: `buildApp`, `createUpdateService`, `dataDir`, `APP_VERSION`.
- Produces:

```ts
// instance.ts — lock file <dataDir>/instance.json = { port, version, pid }
export async function findRunning(dir: string, fetchImpl?: typeof fetch): Promise<{ port: number; version: string } | null>;  // verifies via GET /api/health
export async function pickPort(preferred: number): Promise<number>;   // preferred if free, else an OS-assigned free port
// browser.ts
export function chooseBrowser(defaultProgId: string | null, installed: { chrome?: string; edge?: string }): { exe: string } | null;
```

- **Launcher flow:**
  1. Resolve `dataDir` and create it.
  2. Call `findRunning`.
     - If it finds the same version, open the browser at its port, print the message and exit.
     - If it finds a different version, print «Hay otra versión de Hotspotter abierta (x.y.z); ciérrala y vuelve a abrir esta.», wait for Enter, and exit.
  3. Call `pickPort(7420)` and start `buildApp` with:
     - `webRoot` = the `web` folder next to the exe;
     - `updates` = `createUpdateService({ token: __HOTSPOTTER_GH_TOKEN__ || undefined, … })`.
  4. Write `instance.json`; remove it on exit (SIGINT and console close).
  5. Open the browser and print the Spanish console text:
     - the address;
     - «cierra esta ventana para salir»;
     - a note if the port is not 7420;
     - instructions when neither Chrome nor Edge is found.
- **Browser detection:**
  - The default browser comes from `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice` (ProgId), read with `reg query`.
  - Chrome and Edge are found in their standard install paths under Program Files, Program Files (x86) and LOCALAPPDATA.
  - The browser is launched with the URL as its argument.
  - `HOTSPOTTER_NO_BROWSER=1` skips launching. Tests and the smoke run use it.
- **Build script `scripts/build-portable.mjs`:**
  1. `npm run build`.
  2. esbuild bundles `apps/server/src/launcher.ts` to one CJS file for node22, with these defines:
     - `__HOTSPOTTER_VERSION__` from the root/server package version;
     - `__HOTSPOTTER_GH_TOKEN__` from `process.env.HOTSPOTTER_READ_TOKEN ?? ''`.
  3. Build the SEA blob following the Node 22 docs (`node --experimental-sea-config`).
  4. Copy `node.exe` to `hotspotter.exe` and inject the blob with postject (sentinel fuse per the Node docs).
  5. Copy `apps/web/dist` to `dist/portable/Hotspotter/web`.
  6. Zip to `dist/Hotspotter-<version>-win64.zip`.
  7. Never print the token.

- [ ] **Step 1: Write the failing unit tests.**
  - `pickPort(7420)` returns 7420 when free. With a server listening on 7420 it returns another port.
  - `findRunning`:
    - returns null with no lock file;
    - returns null with a stale lock, where nothing answers or a non-Hotspotter body answers;
    - returns `{ port, version }` when a test server answers `/api/health`.
  - `chooseBrowser`:
    - ChromeHTML with both browsers installed gives chrome;
    - MSEdgeHTM gives edge;
    - FirefoxURL with only Edge installed gives edge;
    - nothing installed gives null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the launcher, the helpers and the build script.
- [ ] **Step 4: Smoke test.** `scripts/smoke-portable.mjs`:
  1. Run `npm run portable`.
  2. Start `dist/portable/Hotspotter/hotspotter.exe` with `HOTSPOTTER_NO_BROWSER=1` and a temp `HOTSPOTTER_DATA_DIR`.
  3. Poll `http://127.0.0.1:<port>/api/health` until the version matches, and check `GET /` serves `index.html`.
  4. Start a second exe and check it exits without starting a server.
  5. Kill both.

  Run it. Expected: PASS. Report the exe and zip sizes.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: portable exe launcher and build`.

### Task 5: Release workflow and CHANGELOG

**Files:**
- Create: `.github/workflows/release.yml`, `scripts/release-notes.mjs`, `scripts/check-version.mjs`, `CHANGELOG.md`
- Test: `scripts/release-notes.test.mjs` (run by Vitest at the root or under server; pick one and wire it into `npm test`)

**Interfaces:**
- `node scripts/check-version.mjs v0.1.0` exits 1 with a Spanish message unless every workspace `package.json` version equals the tag without the `v`.
- `node scripts/release-notes.mjs 0.1.0` prints the `## [0.1.0]` section of CHANGELOG.md, followed by a fixed Spanish footer:
  - «Cierra Hotspotter antes de sobrescribir la carpeta.»
  - The SmartScreen hint: «Más información → Ejecutar de todas formas».
  - It exits 1 if the section is missing.
- **Workflow:**
  - Trigger: `push: tags: ['v*.*.*']`, plus `workflow_dispatch` with input `dry_run` (default true).
  - Runs on `windows-latest`, Node 22, `npm ci`.
  - Installs Playwright browsers only if needed. Run `npm test` only; e2e needs samples/ and WebGPU and is not run in CI. Say so in a comment.
  - Runs check-version, then `npm run portable` with env `HOTSPOTTER_READ_TOKEN: ${{ secrets.HOTSPOTTER_READ_TOKEN }}`.
  - Release: `gh release create <tag> dist/*.zip --notes-file notes.md`, adding `--prerelease` when the tag contains `-`. Permissions: `contents: write` for `GITHUB_TOKEN` only.
  - Dry run uploads the zip as a workflow artifact instead of releasing.
- **CHANGELOG.md:** `## [0.1.0] - <date>`, a short Spanish summary of v0.1, in Keep-a-Changelog style.

- [ ] **Step 1: Write the failing tests** for release-notes and check-version.
  - The section is extracted exactly, up to the next `## [`.
  - The footer is appended.
  - A missing version exits 1.
  - A mismatched version exits 1.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the scripts, the workflow and CHANGELOG.
  - Validate the workflow YAML parses (e.g. `npx --yes yaml-lint` is not allowed as a new dependency; use `node -e` with a tiny parse, or review by hand and state it in the report).
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `ci: release workflow on version tags`.

### Task 6: Docs and closing

**Files:**
- Modify: `docs/08-distribution.md`, `docs/09-decisions.md` (#90 onward: console instead of tray, port 7420 with fallback, running-copy and version handshake, 6 h stable-only check, authError notice, SEA packaging and web folder next to the exe, dry-run workflow), `docs/10-roadmap.md` (mark the `.exe` and the update notices done), `README.md` (a short Spanish "Publicar una versión" section).
- Test: full suites.

- [ ] **Step 1: Write the docs.** The README section must tell the user exactly how to:
  1. Create the fine-grained PAT: only this repo, Contents read-only (plus Metadata).
  2. Add it as the repo secret `HOTSPOTTER_READ_TOKEN`.
  3. Bump versions, add a CHANGELOG section, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
  4. Run the dry run from the Actions tab first.
  5. Rotate the token: revoke it, create a new one, update the secret, publish a new version.
- [ ] **Step 2:** Run `npm test`, `npm run build`, the full Playwright suite in chunks, `node scripts/smoke-portable.mjs` and `npm run bench`. Expected: all pass; bench 7/7 with no check in error.
- [ ] **Step 3:** Commit `docs: v0.1-D distribution`.
