# Storefront extension hardening

Proposed sequence, reviewed against the implementation on 2026-10-13. This is
not a claim that the refactors or new helpers have shipped. Current authoring
APIs remain in [Storefront components](STOREFRONT-COMPONENTS.md).

## Direction

Keep the current render contract: server-rendered markup, batched public data,
small optional islands, immutable release assets and core-owned commerce. Make
the platform's shared responsibilities explicit so a custom design does not
accidentally remove them. No LLM dependency belongs in core.

The Noor overlap exposed a concrete ownership problem: `HeaderLayout.astro`
publishes `--header-height`, but `header/Header.astro` replaces that implementation
when an app provides the header. Product tabs, section navigation, cart summaries
and other core surfaces still consume the variable. Noor instead maintains its
own sticky constants. Rendering either half alone misses this failure.

## Small refactors, in order

| Slice | Change and owner | Developer benefit | Acceptance evidence |
| --- | --- | --- | --- |
| 1. Real integration cases | Extend the existing gallery/local fixture path with packed Noor through the real host, CSS, islands and core product embeds | One place to discover composition defects before upload | Current overlap fails at desktop/phone widths; intended controls and postconditions are checked, including a successful control case |
| 2. Shared layout contract | Host owns active sticky obstruction and layer ordering; core and plugin headers declare their geometry through the same small documented contract | Authors do not copy offsets or depend on private core selectors | Core and Noor pass scroll, resize, announcement, nonsticky, menu-row and anchor cases; subordinate bars have an explicit coexistence policy |
| 3. Shared interaction lifecycle | Audit search/account/cart actions and island mount/unmount; move common behavior out of replaceable markup owners | Optional attribute helpers remove duplicated event/focus code without prescribing appearance | Custom and core openers work; Escape/focus/scroll recovery works; delayed imports cannot mount removed elements or duplicate listeners |
| 4. Explicit render facts | Replace first-section DOM sniffing with the smallest sufficient server-provided fact when needed | Overlay behavior survives host markup changes and works before hydration | Hero-first/content-first, preview/published, section reorder and missing-content cases; all changed facts participate in render memo and dependency validation |
| 5. Author feedback | Reuse the packer, SDK testing helpers and real preview to report contract mistakes with component/setting and repair advice | Short feedback loop instead of reading host internals or production debugging | Declared capabilities, budgets, duplicate IDs and affected full journeys are checked; scaffold/examples use only supported APIs |

Keep `--header-height` as the compatibility contract unless evidence requires a
versioned change; do not add a second offset merely to rename it. Measure actual
obstruction, distinguishing normal flow, sticky menu rows, hidden headers and
transforms. A blanket `rect.bottom` formula is insufficient. Use bounded observers
and scheduled reads; measure any added scroll cost before accepting it.

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

The built-in templates should exercise the same public contracts and checks as
Noor. Keep their Astro implementations; moving them all into plugin packages is
not required to remove hidden privileges. Add a capability when a concrete design
needs it and cannot express it safely through the current surface.

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

## Defer

Do not add a second renderer, a universal hook bus, more layout abstractions,
mandatory plugin wrappers for every visual element, a new preview framework or
an AI runtime in core. Start with the failing real composition case, establish
one host contract, and remove the duplicated implementation it replaces.

The [UI verification contract](UI-VERIFICATION.md) supplies the completion bar:
actual journeys and outcome evidence, coverage exclusions and existing production
performance/security gates. New SDK helpers remain proposals until that evidence
exists; a reviewer approving an approach is not proof that it works.
