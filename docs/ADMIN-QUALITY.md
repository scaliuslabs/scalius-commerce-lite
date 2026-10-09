# Dashboard quality harness

`pnpm quality:admin` opens every screen of the merchant dashboard (`apps/admin-v2`) in headless Chromium (Playwright), at phone, tablet and desktop widths, in English and Bangla. It measures each screen and writes a report. It is the gate for the dashboard polish waves, and the dashboard counterpart of [the storefront harness](STOREFRONT-QUALITY.md).

The harness starts nothing. It audits a stack that runs already.

## Run it

```sh
pnpm quality:admin                                    # every route and surface, 390/768/1440 px, en and bn
pnpm quality:admin --widths 390,1440 --locales en     # fewer variants
pnpm quality:admin --routes /admin/products*,orders   # routes by glob or by part of the path
pnpm quality:admin --family settings,products         # route families (the first part after /admin)
pnpm quality:admin --family surface                   # only the dialogs, sheets and menus
pnpm quality:admin --no-shots                         # no screenshots (smaller output, faster)
pnpm quality:admin --list                             # print the plan and stop
pnpm quality:admin --base-url http://localhost:4400/admin   # another dashboard (see UI preview below)
```

Install the browser once: `pnpm exec playwright install chromium`.

Other flags: `--out <dir>` (default `.quality/admin`), `--concurrency <n>` (default 3).

Output goes to `.quality/admin/` (gitignored): `index.html` (the report), `results.json` (the summary and every finding), `shots/<route>/<width>-<locale>.jpg` and `auth/state.json`. The state file holds the session cookies of the test admin. Delete the whole `.quality/` folder when you have read the report: the disk is limited.

Exit code 1 when a gating finding is not in `scripts/admin-quality/allowlist.json`.

## What it does

1. **Signs in.** It reads the local test admin's defaults from `scripts/dev-admin.mjs` when it starts (`LOCAL_ADMIN_EMAIL` and `LOCAL_ADMIN_PASSWORD` in the environment override them). It signs in through the real sign-in endpoint of the audited origin. It never prints or stores the password. Only the session is saved, as a Playwright storage state.
2. **Finds the routes.** It reads `FileRoutesByTo` in `apps/admin-v2/src/routeTree.gen.ts`: one entry for each URL a person can open. A new screen is audited with no list to edit.
3. **Fills the route parameters.** For `$productId`, `$orderId` and the others it reads one real id from the API list endpoint of the resource (`scripts/admin-quality/params.mjs`). When a store has no row of a kind, the route is listed as skipped with the reason. Routes that need a token or a live request are skipped on purpose (`SKIPPED_ROUTES` in `routes.mjs`).
4. **Opens the surfaces.** `scripts/admin-quality/surfaces.json` lists dialogs, sheets and menus. Each item has a route, small named steps (`press`, `click`, `fill`, `wait`) and a `waitFor` selector. A step with `measure` is timed as an interaction. A surface with `"modal": true` also checks that Tab stays inside it. Add `"locales": ["en"]` to a surface whose selector uses English text.
5. **Audits each page.** One page per route, width and language. The language is set in the browser storage before the page starts (`scalius.dashboard.locale`).

## Rules

Each finding has a stable rule id. A **gating** finding fails the run. An **advisory** finding is a number to bring down.

| Rule | What | Gates |
|---|---|---|
| axe rules | axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags. The rule id is the axe id. | yes, for `serious` and `critical` |
| `render` | The page shows the dashboard's error or not-found screen, the document answers 4xx or 5xx, or a surface does not open | yes |
| `blank-page` | The page settles with nothing in `main` | yes |
| `load-stuck` | A skeleton or busy state is still on screen after 15 s | yes |
| `overflow-page` | The page scrolls sideways, or content is cut off at the edge | yes |
| `overflow-container` | A card or table is wider than the box that holds it | yes |
| `leaked-value` | A raw translation key, ICU syntax (`{count, plural`), an unfilled `{placeholder}`, `undefined`, `NaN`, `Infinity`, `[object Object]` or `Invalid Date` is visible | yes |
| `page-error` | An uncaught script error | yes |
| `network-5xx` | A request answered 5xx | yes |
| `table-scroll` | A table scrolls sideways inside its card | no |
| `clipped-text` | Text is cut off with no ellipsis (`scrollWidth` above `clientWidth` under `overflow: hidden`) | no |
| `truncated-no-title` | Text is truncated (ellipsis or line clamp) and no `title`, `aria-label` or tooltip carries the full value | no |
| `control-height` | Inputs, selects, comboboxes or buttons in one form section or one row differ in height by more than 1 px | no |
| `field-misaligned` | Fields stacked in one form column start more than 1 px apart | no |
| `wrong-language` | English interface text in the Bangla dashboard | no |
| `html-lang` | `<html lang>` does not match the dashboard language | no |
| `console-error` | The page logged an error to the console | no |
| `network-error` | A request answered 4xx or failed | no |
| `layout-shift` | CLS above 0.1 over the load plus 3 s | no |
| `load-first-render` | First contentful paint later than 1 s | no |
| `load-settled` | Content with no skeleton settled later than 1 s | no |
| `skeleton-shape` | The skeleton and the final content differ a lot in height (the page jumps when it settles) | no |
| `interaction-latency` | A named interaction shows no visual response within 100 ms | no |
| `focus-visible` | A control looks the same focused and unfocused, in the first 15 Tab stops (WCAG 2.4.7) | no |
| `focus-trap` | Tab stays on one element, focus leaves the page, or focus leaves an open modal | no |
| `redirected` | The route ended on another address | no |

### How the checks work

- **Facts and judgments are apart.** `page-facts.mjs` runs in the browser and returns plain data. `analysis.mjs` judges it. Unit tests run the judgments on fixtures.
- **Control heights.** Fields in one section (form, card, dialog) must have one height. A field and a text button in one row must have one height. Icon-only buttons, controls in tables, menus, toolbars and navigation are skipped.
- **Clipped text.** The harness looks at elements with their own text where `scrollWidth` is above `clientWidth` (or the same for height). Scroll containers and 2 px of rounding are ignored. Truncation is intended when `text-overflow: ellipsis` or a line clamp is set; then the full value must be available in `title`, `aria-label` or a tooltip.
- **Wrong language.** In Bangla mode every visible text, placeholder, title and label is split into Latin words. A word is accepted when it is in `scripts/admin-quality/language-allowlist.json` (brands and technical terms, plus phrases and patterns), has digits, or is part of an email, URL or path. Table cells, rich content and code are data and are skipped.
- **Load timing.** First contentful paint is the browser's own. Settled means no `.animate-pulse` or `aria-busy` element and text in `main`, for 300 ms.
- **Interaction latency.** The time from the input event to the paint after the first DOM change. The set is small: typing in the list search, switching a tab, and the `measure` step of each surface.
- **Layout shift.** The harness waits 3 s after the content settled, then reads CLS.
- **Screenshots.** JPEG, one per route, width and language. The dashboard scrolls inside its canvas, so a screenshot shows the first screen of the page.

## Allowlists

- `scripts/admin-quality/allowlist.json`: `findings` (gating findings you accept: `entry` is a route glob, `rule` a rule glob, optional `widths` and `locales`, and a `reason`), `network` (expected 4xx/5xx by path glob and status) and `console` (messages to ignore, as regular expressions). Every item needs a `reason`.
- `scripts/admin-quality/language-allowlist.json`: terms, phrases and regular expressions for `wrong-language`.

## Known limits

- Timing depends on the machine and on the number of pages in flight. Use `--concurrency 1` for timing numbers you want to compare.
- `wrong-language` is a heuristic. Store data in headings (a product name in English) can be reported. Add the term to the allowlist only when it is a brand or a technical word.
- `focus-visible` and `control-height` can report a control that is styled on purpose. Check the screenshot before you change a component.
- A page can only be audited with the data in the store. A store with no gift cards has no gift card page to audit (listed as skipped).

## UI preview: a worktree dashboard on another port

A polish worker in a git worktree has no secrets and must not create `.dev.vars`, so it cannot run the whole stack. It can run its own dashboard UI against the shared local API (port 8787, from the main stack):

```sh
SCALIUS_DEV_ADMIN_PORT=4400 pnpm --filter ./apps/admin-v2 exec vite
pnpm quality:admin --base-url http://localhost:4400/admin --routes /admin/products*
```

The worker edits `apps/admin-v2` and sees the change on `http://localhost:4400/admin`. Use `pnpm --filter ./apps/admin-v2 exec vite`, not `pnpm dev`.

### Why a second port needs help

The API trusts one dashboard origin: the Platform setting (`GET /api/v1/platform`, `dashboardUrl`, `http://localhost:4323` locally). Better Auth's trusted origins, the cookie-origin guard (`apps/api/src/middleware/cookie-origin-guard.ts`) and the realtime check all compare the browser's `Origin` header with it. A dashboard on port 4400 sends `Origin: http://localhost:4400`, so sign-in answers `INVALID_ORIGIN` and every cookie write answers 403.

### What the preview does

The Vite dev proxy in `apps/admin-v2/vite.config.ts` presents the Platform dashboard origin as the `Origin` (and `Referer`) of requests that carry one (`previewProxyOrigin` in `scripts/dev-ports.mjs`). It reads that origin once from `GET /api/v1/platform`.

- It rewrites only when both origins are loopback (`localhost`, `127.0.0.1`, `[::1]` over `http`). It never rewrites toward a real domain.
- It is in the Vite dev server only. It is not in a bundle, and `apps/api` is unchanged: the API still enforces every origin check.
- It adds no environment variable and no secret. Ports come from `scripts/dev-ports.mjs` as before.
- Cookies do not use the port, so the browser session of `localhost:4323` and `localhost:4400` is one session.

Tests: `previewProxyOrigin` in `scripts/dev-ports.test.mjs`.

### Limits

- Links the API writes into mails, or Platform settings, still point at the main dashboard port.
- It needs the shared API and its database to run on this machine (port 8787).
