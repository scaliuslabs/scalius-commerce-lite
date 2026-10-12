# Storefront extension hardening

Implemented, deployed and verified on 2026-10-13. Authoring APIs are documented in
[Storefront components](STOREFRONT-COMPONENTS.md).

## Direction

Keep the current render contract: server-rendered markup, batched public data,
small optional islands, immutable release assets and core-owned commerce. Make
the platform's shared responsibilities explicit so a custom design does not
accidentally remove them. No LLM dependency belongs in core.

The Noor overlap exposed a shared responsibility inside replaceable core markup:
the core header published geometry that product navigation still needed after an
app replaced it. Geometry and common actions now belong to the host; core and
Noor declare the same public contracts.

## Implemented contracts

| Surface | Implementation |
| --- | --- |
| Integration gallery | Packed Noor runs through the real host with its stylesheet, islands and core product embeds, including sparse, dense, language, direction and failure fixtures. |
| Shared geometry | `stickyHeader()` marks the actual sticky box. The host publishes its top inset plus height as `--header-height`, selecting the eligible box at each breakpoint. Product navigation reserves its own height; the desktop buy bar reserves space before becoming visible. Phone bottom bars never become top offsets. |
| Shared actions | `searchOpener()` and `accountLink()` opt into delegated host actions. Modified and handled clicks retain their behavior. Account state is checked at activation, and native popovers close before handing control to host UI. |
| Island lifecycle | Connection generations and cancellation prevent late imports from mounting removed elements. Reconnection re-arms hydration; host subscriptions are disposed when mounting or listeners fail. |
| Header lead fact | Optional `data.page.lead` identifies the first selected homepage unit only when desktop and phone agree. Only the same app receives normalized settings and resolved media; product lists are empty. The existing homepage read supplies the fact, which varies only the header job memo. An inert `data-scalius-lead-empty` marker guards failed or empty lead rendering. Noor decides transparency on the server without private DOM selectors. |
| Author feedback | SDK contract diagnostics and the existing packing/testing path give actionable feedback. The helpers and gallery exercise the supported contracts without introducing another renderer or preview system. |

Geometry reads are coalesced through animation frames and bounded observers,
without a host geometry read on every scroll. Layer tokens are available to
authors; the host does not force their custom CSS. Transforms do not reduce the
reserved height, so a sliding header can leave a conservative gap. The existing
`--header-height` contract is retained.

Do not require search, navigation or stickiness in every header: logo-only
campaign headers are valid. Check the capabilities a component declares. Custom
markup, styles and behavior remain possible through documented contracts, with
accessible host defaults available as helpers rather than mandatory layouts.

## Responsibilities and guarantees

| Owner | Responsibility |
| --- | --- |
| Host | Commerce authority, authorization, supplied public data, release/cache identity, core embeds, shared layout/interaction contracts and bounded failure handling |
| SDK | Small typed authoring helpers, documented attributes/data, fixture builders and contract checks; no new source of commerce authority |
| Theme/plugin | Visual composition, custom CSS and behavior, declared capabilities and costs, correct cleanup and use of public contracts |

Core and Noor now exercise the shared contracts without moving the built-in
Astro templates into plugin packages. Add a capability when a concrete design
cannot express its needs safely through the current surface.

The guarantees must match the execution boundary. Uploaded server modules can
have isolated CPU/network limits; bundled modules are trusted deployment code.
Browser islands run on the storefront's origin and are not isolated from its DOM.
Server authorization and authoritative checkout prevent accepting unauthorized
operations or client-supplied prices; they do not sandbox browser JavaScript.
Approval and budgets make those choices explicit. Arbitrary code and zero cost
or risk cannot both be promised.

Technical fallback does not establish visual correctness. Release-addressed
assets do not by themselves prove page freshness: retain dependency validation,
including plugin activation, settings and every render input. Never add cache
purges as a shortcut.

## Verification and remaining limits

Typechecks, focused regressions, rendered-component tests and existing
render/batch budget checks pass. Tests cover settings isolation and memo changes,
empty-lead fallback, lifecycle races, action handoff and sticky-bar selection.
The owning tests are beside the host scripts, extension data adapters,
Noor components, and SDK helpers. `pnpm typecheck` and `pnpm release:check`
provide the broader gates.

Local Chrome browser checks exercised desktop and phone core menu rows, Noor
header variants, Bangla/RTL/dense content, static and fallback headers, product
tabs/navigation/buy bars, direct anchors, and search/account handoff. The
local geometry matrix and before/after captures record those composition
checks. They do not establish real order placement or payment success. Opus 5.5
High reviewed the design, patch, final integration and anchor correction; its
final verdict found no concrete blockers.

The deployed Noor product also passes desktop tab positioning, phone navigation
and review anchors, native search focus, and menu-to-account handoff. The release
smoke passed for build `src-faca43fc9df89989`: API version
`3d6486d6-3ef9-4d9e-9656-8a48b387833b`, storefront version
`84be6b15-9b9e-40ed-b047-3ccf77ce304a`. Runtime changes are in commit
`eb86914f6`. Detailed local evidence is retained under
`audit/polish-2026-10/storefront-host-contracts-20261013/`.

Native Safari remains unverified, particularly popover focus restoration and
phone safe-area behavior. The empty-lead CSS guard requires `:has`. The desktop
bar's 64rem selection must remain aligned with Tailwind's `lg` breakpoint. A
future client router needs a fresh anchor/navigation check; this storefront
currently uses full-page navigation. Arbitrary plugin JavaScript and custom CSS
still require their own composition and journey verification.

## Defer

Do not add a second renderer, a universal hook bus, more layout abstractions,
mandatory plugin wrappers for every visual element, a new preview framework or
an AI runtime in core. Continue from concrete composition failures and remove
duplicated implementations when establishing a shared contract.

The [UI verification contract](UI-VERIFICATION.md) supplies the completion bar:
actual journeys and outcome evidence, coverage exclusions and existing production
performance/security gates. Reviewer approval complements execution evidence;
it does not replace it.
