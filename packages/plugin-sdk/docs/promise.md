# What we promise

You are deciding whether to build an app or a theme on Scalius and keep it for years. This page says what stays the same across releases, what does not, how a break would be made, and how fresh the data your app reads is. If another page disagrees with this one about the policy, this page holds; if any page disagrees with the code, the code holds.

## Where this stands

- The contract is frozen at `v2.0.0-rc.1` as a candidate. The promise starts at `2.0.0`.
- Between rc.1 and 2.0.0 we intend no break. If one proves necessary, it is listed in the release notes and in the contract's break ledgers (`abi.breaks.json`, `stable-operations.breaks.json`, `events.representations.breaks.json`, `contract.breaks.json`, in the public repository).
- `contract.lock.json` at the repository root records every sealed snapshot as it was at the freeze. From then on a sealed change is accepted only with a ledger entry written after the lock and typed `growth`, `security` (naming its advisory) or `new-version`; see [How it is enforced](#how-it-is-enforced). `node scripts/contract-lock.mjs status` shows which seals moved since the lock and what each ledger recorded since.
- There is one contract version today: `2026-10` (`PLUGIN_API_VERSION`, equal to `EVENTS_API_VERSION`).

## What is covered

Within a supported contract version, a release only adds to these. Each names, in parentheses, the seal that enforces it: a committed snapshot whose test refuses anything but growth.

- **The app manifest**: every field `defineManifest` and `parsePluginManifest` accept, `apiVersion` and `minPlatformVersion` included ([Apps](apps.md#the-manifest)) (`abi.manifest.snapshot.json`).
- **The SDK's exported entry points and types**: `definePlugin`, `ctx`, the providers, the test harness and fixtures (`abi.sdk.snapshot.txt`, the emitted declarations).
- **Functions**: each point, its input and its output, and the failure policies a manifest declares ([Commerce hooks](commerce-hooks.md#2-the-checkout-function-interface)) (the protocol seal's `functions` and the manifest seal).
- **Events**: topics, facts, webhook representations, delivery headers and signing ([Event reference](events.md)) (the protocol seal's `events`, `events.representations.snapshot.json`, and the `delivery` table: the header names, the secret prefix, the tolerance and one signature the test signs again).
- **The dashboard and buyer UI protocols**: admin UI documents and surfaces, Buyer UI extensions and their slots (the protocol seal's `ui`, `extensions` and the storefront slot constants).
- **The 209 stable operations** an app calls with `ctx.api.call` ([Stable app API reference](operations.md)): names, scopes, parameters, bodies, responses, success statuses and the names of their schemas (`sample("OrderResource")`) (`stable-operations.snapshot.json`), and the error codes (`APP_ERROR_CODES`) with each code's meaning, details and HTTP status (the protocol seal's `errors`).
- **Stable provider ports**: their required operations and schemas (the protocol seal's `providers` and `providerRequired`).
- **The theme document and its upgrade chain**: a stored theme, template or page preset of any `themeVersion` from 10 on is read and upgraded, never reset ([Storefront](storefront.md#stored-themes-and-versioning)) (`compat.snapshot.json` under its own rule, the frozen goldens `compat/v*`, and `read-bounds.snapshot.json`: a bound a stored theme is read against only rises).
- **Skin projections**: what a skin reads. When core changes a section, the host adapts so your input stays the same ([Skins](storefront.md#skins)) (the protocol seal's storefront constants, `STOREFRONT_SECTION_SKIN_PROJECTIONS`, and the SDK declarations).
- **The storefront component protocol**: the component ABI, slots, targets, embeds, data shapes and the pack format. Its limits only loosen (the protocol seal's storefront constants; `STOREFRONT_COMPONENT_LIMITS` may only rise).
- **Sealed tokens and names**: the host CSS variables in [Build a theme](themes.md#7-every-language-and-logical-css) (`STOREFRONT_HOST_CSS_VARIABLES`) and the hooks on the store's public markup: [the buy form's anatomy](storefront.md#styling-the-buy-form), [placed offers and kits](storefront.md#placed-offers-and-kits), related products, the filters wrapper, the sticky buy column and [the phone bar](storefront.md#styling-the-stores-phone-bar) (`STOREFRONT_HOST_HOOKS`) (the protocol seal's `hostCssVariables` and `hostHooks` tables; a test reads each from the markup that writes it). The names hold; the nesting between them and the classes inside do not.
- **What app markup may hold**: the skin HTML allow-list (tags, attributes, their values and patterns) and the functions a `style` attribute may call, listed in [Storefront security](storefront.md#security) (`STOREFRONT_STYLE_FUNCTIONS`). Inline style is a permanent part of the contract. Both lists only grow (the protocol seal's `skinHtml` table and storefront constants).
- **The limits an app is built against**: the per-app quotas of both plans (CPU, wall time, calls per run, storage, runs and messages a minute, running jobs, held events), the checkout function wall cap and budget, a function's reads, UI, buyer UI, object, job, message, upload and template sizes, the package sizes a store accepts (which `pnpm plugin pack` and `validate` check with the same numbers), and the topics one webhook may name. A maximum only rises (the protocol seal's `limits` table).
- **What the store refuses**: the store's action and amount words, their slot patterns and each label kind's reach, the theme's amount words, and the reasons every check site gives with a digest of the constants it reads (theme save, app templates, manifest policy, buyer UI, function answers, storefront markup, pack) (the protocol seal's `storeWords`, `storeWordSlots`, `storeWordKinds` and `themeLabelAmountWords` tables, and `refusal-census.snapshot.json`). A new word or reason is a new refusal: only the security exception adds one.
- **The private-page model**: page keys, part and target names, variants, style targets, tokens and their types, label keys and refusal reasons ([Design the buyer's private pages](private-pages.md)) (`private-anatomy.snapshot.txt` under its own rule, with each token's type; `save-reasons.snapshot.json`, with the checker and policy versions).
- **Released apps and themes keep working**: every bundle built against this release or later replays with the outcome it had when it was frozen (`tests/replay`, whose frozen expectations the lock records).

"Only adds" means a new optional field, operation, event, function point, slot, token, error code or list value. Every list you read is open and may gain values, so handle a value you do not know as that list says ([commerce hooks](commerce-hooks.md#value-lists-you-read-are-open), [storefront](storefront.md#value-lists-you-read)); a list you send is closed. Removing, renaming or retyping something, making an output nullable, adding a required input, changing a default, or refusing at save, install or run something that passes today is a break.

## What is not covered

- **The database schema.** Tables, columns, migrations and triggers. Apps and themes never see a table, and the schema may change in any release.
- **Every operation that is not one of the 209 stable ones**: beta and internal operations, the dashboard's REST API and the storefront's REST API (`/api/v1/...`), and agent or CLI commands built on them. An agent's saved script is covered only where it calls stable operations.
- **Undocumented DOM and CSS.** Core markup, class names, element nesting, script order and bundle internals. Only the names listed above hold.
- **Which error code an operation answers in a given case.** The codes themselves, their meanings and statuses are covered. Branch on `code`, and treat a code you do not know by its HTTP status.
- **Anything marked beta**, wherever it appears, beta provider ports included (their snapshot is reviewed, not sealed).
- **Timing and order** beyond what [Consistency](#consistency-of-what-your-app-reads) says.
- **What the host does with a failure** beyond the declared policy: when a slow or failing app is left out, and how its circuit counts. The replay of released bundles does not run checkout functions.
- **Limits not in the sealed table**: an app's outbound HTTP (`ctx.http.fetch` sizes, redirects and timeout), route body sizes, a buyer UI run's CPU, the offer run's 300 ms, and Cloudflare's own plan limits.
- **A check that refuses more without changing its listed constants or reasons**: the refusal census sees a new reason or a changed list, limit or pattern, not a new branch inside a check. The private-page CSS allow-list may shrink for security at any time.
- **Undocumented host CSS variables**: any custom property the store writes that `STOREFRONT_HOST_CSS_VARIABLES` does not list (`--mobile-tabs-reserve`, `--theme-ink`, the `--theme-text-*` steps) is internal.

## The security exception

A check may be tightened only to close a security hole. Each one gets a dated note in the release notes that names the check, what it now refuses and what an affected app or theme must change.

- A stored theme is never dropped. A value a tighter check refuses is left out of the read (a link reads as no link, a tab or a card is left out) and the rest of the theme keeps its design; a private page a tighter check refuses falls back to the store's own look on its own, the other pages keep theirs, and the merchant's theme page says which page or part and why until a save fixes it. A stricter check keeps serving a page's look until the store compiles it again; only a change to what the store writes shows the store's own look meanwhile.
- For an app, an answer the tighter check refuses is treated like any invalid answer at that point (see [Failure policy and limits](commerce-hooks.md#failure-policy-and-limits)).

## How it is enforced

- Every surface above is a committed snapshot with a compatibility rule; its test refuses a removal, a retype, a narrower input, a new requirement or a new refusal unless a ledger entry names that exact change and the snapshot it changes from.
- Each ledger entry has a type: `growth`, `pre-lock` (made before the freeze), `security` (with its advisory id and date) or `new-version` (with the contract version it belongs to).
- `contract.lock.json` fixes every snapshot as it was at the freeze. After it, each seal also compares with the locked snapshot, so a snapshot rewritten by hand is still refused, and accepts only entries written after the lock and typed `growth`, `security` or `new-version`. The entries before the lock, the theme goldens and the frozen replay expectations never change.
- The seals run on every commit. Their tests are not in the public repository, which carries the lock, the snapshots and the ledgers to read.

## Versions

- One dated contract version covers everything above. An app declares it as `apiVersion`. A webhook endpoint keeps the version it was created with and sends it as `Scalius-Api-Version`. `SUPPORTED_PLUGIN_API_VERSIONS` lists the versions a store runs; install, activation and update refuse any other, with a plain reason.
- Additive changes ship in any release, with no new version.
- A break means a new contract version. There is at most one new version a year, and each ships with a host adapter that keeps the old version's shapes for apps that declare it. Themes keep working through the document's upgrade chain.
- A version keeps working for at least 24 months after its successor ships. At most two are live at once. Something deprecated keeps working until its version leaves support.
- Today one version exists, and the adapter mechanism is not built yet. It will be built with the first new version, before that version ships. The same goes for the storefront component ABI: the host accepts ABI `1` only, and accepting an older ABI will be built with the first new one.

## Consistency of what your app reads

**Stable reads are authoritative.** Each `ctx.api.call` reads the store's database when you call it, never a cache. Within a run, reads never go back in time and they see every write the run made. A write that another request commits just before or during your run may only show in a later run. The counts and totals in a stable answer are exact when read, because they are computed live or kept up to date by the database in the same write. That includes a customer's `totalOrders`, `lastOrderAt` and spend, a discount's redemption counts, and `analytics.get_summary`. A segment's members are evaluated as you page, so a customer who joins or leaves between pages may be missed or seen once.

**Some things are derived and may lag:**

- **Event delivery.** An event is written in the same commit as the change. It is sent right after that write, and what does not fit is sent by a drain every minute, a few deliveries per drain on Workers Free and more on Paid. Under a burst, events can wait minutes, and no upper bound is promised. While your app is not running, its events wait up to the plan's bound ([Events](apps.md#events)).
- **A webhook's `data`** is read when each attempt is sent, not when the event happened. It can be newer than the event's `facts`.
- **States set outside the store.** A shipment's `status` is what its courier last reported (`rawStatus`, `lastCheckedAt`). A payment or refund stays `pending` until its provider settles.
- **Storefront data a theme draws** can be briefly behind a committed write: about a second by design, which is a target and not a promised bound. Recommendations and "popular" lists are computed in the background: recommendations after a catalogue write and in a daily rotation, popular products nightly from the last 30 days of orders.

**Events are delivered at least once and may arrive out of order.** The events of one commit have no set order between them, and a retried delivery can arrive after a later event. So:

- Key your work by `event.id` (for webhooks, `Scalius-Event-Id`), so a repeat changes nothing.
- Treat an event as a sign that something changed, then read the resource for the truth (`orders.get`, and so on). Compare its `revision` or `updatedAt` with what you stored, and skip anything older.
- Write under `expectedRevision`. A 409 means someone wrote first: read again and decide again.
- After a gap, catch up with `updatedSince` instead of replaying events.
