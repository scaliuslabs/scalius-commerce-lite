# Storefront quality harness

The harness renders every storefront section, block, template and page kind, and measures each one in a browser. It has two parts:

- **The section gallery** (`apps/storefront/src/gallery/`, served by `apps/storefront/scripts/gallery-server.mjs`). It renders the real storefront pages through Vite, with a fixture store and a fixture API. It needs no API, no database and no secrets.
- **The audit** (`scripts/storefront-quality.mjs`). It opens each gallery entry in headless Chromium (Playwright) at 390, 768, 1280 and 1440 px, runs the checks, takes screenshots and writes a report.

## Run it

```sh
pnpm quality:storefront                       # start the fixture gallery, audit every entry
pnpm quality:storefront --family section:hero # only some families (prefix match)
pnpm quality:storefront --only listing,token  # only entries whose id contains one of these
pnpm quality:storefront --widths 390,1280     # other widths
pnpm gallery:storefront                       # only the gallery: open http://127.0.0.1:4799/__gallery/
pnpm quality:storefront --base-url http://127.0.0.1:4799                    # audit a gallery that runs already
pnpm quality:storefront --base-url http://localhost:4321 --paths /,/cart    # audit real pages of a running `pnpm dev`
```

Install the browser once: `pnpm exec playwright install chromium`.

Output goes to `.quality/storefront/` (gitignored): `index.html` (the report: findings and screenshots side by side), `results.json`, `shots/<entry>/<width>.jpg` and, with a baseline, `diffs/`.

Visual diff: run once with `--update-baseline` to keep the current screenshots in `.quality/storefront-baseline/` (or `--baseline <dir>`). Later runs compare against it and report `visual-diff` when more than 0.5% of the pixels change.

A full run of about 330 entries takes about 10 minutes with 4 pages at a time (`--concurrency`).

## What it checks

Each check looks only at the entry's region (`focus`: a section, the header, the footer, the main content or the whole page).

| Rule | What | Gates |
|---|---|---|
| axe rules | axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags (contrast, names, `target-size` for WCAG 2.5.8, and more) | yes, for `serious` and `critical` |
| `overflow` | The page scrolls sideways because of an element in the region | yes |
| `render` | The page answers 4xx or 5xx | yes |
| `overflow-outside-focus` | Sideways scroll caused outside the region (reported on the entry of that region) | no |
| `focus-missing` | The region is not on the page: the variant rendered nothing | no |
| `keyboard-unreachable` | A visible control cannot take keyboard focus, or an element has a pointer cursor but is not a control | no |
| `focus-visible` | A control looks the same focused and unfocused (WCAG 2.4.7) | no |
| `layout-shift` | CLS above 0.1 while the page loads | no |
| `img-dimensions` | An image has no `width` and `height` and no CSS `aspect-ratio` | no |
| `color-contrast-review` | Text that axe cannot measure (over a photo or a gradient): check it by eye | no |
| `contrast-dark-preference` | Text that fails contrast only when the browser prefers a dark colour scheme | no |
| `lang`, `dir` | The page `lang` and `dir` do not match the entry's locale (Bangla, Arabic RTL) | no |
| `lang-of-parts` | Bangla or Arabic text in an element whose language says otherwise (WCAG 3.1.2) | no |
| `console-error` | The page logged errors | no |
| `visual-diff` | The screenshot changed against the baseline | no |

Colour schemes: every palette with each header tone and every token value is an entry, so axe measures text contrast in each one.

Exit code: 1 when an entry has a gating finding, else 0. To accept a gating finding, add it to `scripts/storefront-quality/allowlist.json` with a reason: `{ "entry": "<id or glob>", "rule": "<rule>", "widths": [390], "reason": "..." }`. Keep the list empty or very short; fix the component instead.

## How the gallery stays in sync

- `entries.ts` reads the registry (`@scalius/shared/storefront-theme`): every template on 5 page kinds, every section type, every block variant in `STOREFRONT_BLOCK_REGISTRY`, the listing, navigation and product composites, the tokens and palettes, the app surfaces, the page kinds and the Bangla and RTL presences.
- `variants.ts` reads the Zod schemas: each enum value, boolean and literal of a section's or a block's settings becomes an entry, one setting at a time. A new option value in the registry is a new entry with no gallery change.
- Every entry is a saveable theme document (validated with the save schema). The storefront renders the default theme for an invalid one, so an invalid entry fails.
- `entries.test.ts` fails when a section type has no fixture content, when a block variant, template, module, sticky bar or palette has no entry, or when code outside `src/gallery/` imports the gallery.
- The gallery renders the real page modules (`src/pages/*.astro`) with the real layout and components. It is not a second renderer.

The `catalog:cardinality` entries share finite catalogs of 0, 1 or 200 products across home sections and listing pages. Their continuation links end at the real final page; the Bangla entry exercises load-more paging. Sparse stores use the normal theme fit rules, including omitting EndlessGrid below 40 products. `catalog:missing-media` keeps configured section image references while answering with no matching media, so the real fallback renders. These fixtures do not change section limits or measure production performance.

## How to add a section

1. Add the type to the registry in `packages/shared/src/storefront-theme/sections.ts` and its renderer as usual.
2. Add realistic content for it in `apps/storefront/src/gallery/section-content.ts`: what a merchant fills in, with Bangla text and one item without a photo where it applies. Add discriminated-union options (for example, product sources) to `alternatives`.
3. If the section reads new data, answer that read in `apps/storefront/src/gallery/api.ts`. The gallery index lists each entry's `unanswered` reads.
4. Run `pnpm exec vitest run apps/storefront/src/gallery` and `pnpm quality:storefront --family section:<type>`.

## Not in the production build

- The gallery lives in `src/gallery/`, outside `src/pages/`, and no route imports it (`entries.test.ts` checks this). Tailwind does not scan it (`@source not "../gallery"`).
- `src/gallery/server.ts` throws in a production build, and the gallery server refuses to start with `NODE_ENV=production`. It listens on 127.0.0.1 only.
- `pnpm check:dist-secrets` (part of every storefront build and deploy) fails when the storefront build output names the gallery or its fixture API.
- The gallery renders in Vite dev mode: CSS and scripts are unbundled. Use `pnpm perf:storefront` for production timing; the storefront render budgets do not include the gallery.

## Accessibility foundations

These rules live in `apps/storefront/src/styles/theme-foundation.css`. Components read the tokens; they never set their own numbers.

- **Focus ring.** `--focus-ring-width`, `--focus-ring-offset` and `--focus-ring-color` give every control one visible ring (WCAG 2.4.7). A component draws its own ring only when the shared one cannot show (inside a scroll list, on a coloured surface), and then draws it on the control itself, never on a child.
- **Minimum target.** `--target-min` (24px, WCAG 2.5.8) is the floor for buttons, summaries, selects and text fields. A list of links sets `min-block-size: var(--target-min)` on its link. A check box is 14px, so its row pitch is its clear space: listing `rowPitch` is at least 24.
- **Names hold the visible text** (WCAG 2.5.3). Do not put an `aria-label` on a control that shows words, and do not hide those words with `aria-hidden`. Where a style shows only the icon, keep the words in the page visually hidden. Text on a primary tint uses `text-primary-ink`, not `text-primary`.
- **Lists of results do not use `content-visibility`.** A stand-in size shifts the page when the real size arrives (the footer on a short page), and the stand-in boxes overlap the controls below.

## What the gallery does for the audit

- The cart lives in the browser, so the cart entries (`page:cart`) carry a seed (`gallery/cart-seed.ts`: 1, 3 or 10 lines, a sold-out line, a Bangla cart). The index hands it to the harness, which writes `cart:v3` before the page loads; the fixture API answers the cart check for it. An entry without a seed audits the empty cart.
- The layout fixture names the gallery origin as the API (Platform settings take an origin only). The server answers `<origin>/api/v1/...` from the fixtures of the entry that asked (the page's Referer in the browser, the render's entry on the server), so browser reads such as the cart's delivery rates work.
- Component styles are inlined in the page and the first paint waits for the whole page (`<link rel="expect" blocking="render">`). The dev page is large; without this the browser paints it half parsed and the footer grows as its markup arrives, a shift no shopper sees.
