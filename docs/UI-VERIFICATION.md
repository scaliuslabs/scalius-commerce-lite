# UI verification across core, themes and plugins

Use this contract when auditing or changing a buyer or merchant journey. The
unit of verification is a **composed journey in a named state**, not a component,
test count or screenshot. Use it with the [storefront quality harness](STOREFRONT-QUALITY.md)
and the owning domain's release requirements.

## Start from the failure class

For each reported defect, name the user expectation, the violated invariant,
its owner and its other consumers before choosing a fix. Then check an adjacent
consumer and a different transition that could violate the same invariant.

| Example | Invariant | Expand the investigation to |
| --- | --- | --- |
| Noor tabs cover the header after scrolling | Visible controls remain reachable below the active sticky chrome | Other headers, product bars, catalog filters, cart summaries, anchors, resize and overlays |
| Edit then restore still asks to save | Dirty state compares normalized current values with the saved baseline | Rich text, numbers, collections, undo/redo, failed saves and conflict recovery |
| Buy now removes an existing cart line | Cart changes follow the buyer's action and preserve unrelated lines | Add A then Buy B means A+B, quantity limits, reload/back, checkout recovery and new lines added during checkout |
| Delivery text disagrees between surfaces | Commerce claims come from the applicable authoritative quote | Free delivery, app rates, markets, unavailable zones and stale merchant-written copy |
| A portrait preview is clipped | Preview lets the user inspect the whole asset | Panorama, small images, zoom, fullscreen, narrow screens and metadata panels |
| A customer must scroll past the entire conversation to reply | Conversation history has a bounded reading pane and the composer remains reachable | First unread, older history, live arrival while reading, attachments, narrow/short viewports, no-JavaScript fallback, core templates and plugin headers |
| An Inbox workspace scrolls out of its frame | The shell owns available height; only its work panes scroll | Route scroll restoration, hidden accessibility labels, focus, offline banners, reply-mode changes and phone/desktop resizing |
| Canvas scrolling redraws the whole editor | Transient frame geometry updates only its visual overlay | Hover, inline text, duplicate geometry, session replacement, latest scroll restoration and stale frame messages |
| Choosing a section changes the draft before confirmation | Browsing previews is read-only; Add inserts exactly once at the current anchor | Core and unused active apps, real styles, empty content, rapid selection, expired sessions, cancel, keyboard and touch |
| A builder notice blocks editing | Notices can collapse without losing recovery actions or covering selection controls | Route, version, conflict and failure notices; hidden-frame refresh; new messages; narrow canvas and retained focus |
| Banner arrives without sound | Delivery, in-page audio and native device sound are different outcomes | Browser permission, service worker, foreground/background, OS settings and actual device observation |

Do not automatically change merchant copy to match a quote or call it a pricing
calculation defect. Record who owns the claim. Notification permission and a
running AudioContext do not prove that an OS notification made a sound.

## Model the journey before checking it

Record the role, route, theme/plugin release, preview versus published state,
viewport and input method, locale/direction, relevant data and ordered actions.
Include the expected outcome before inspecting the proposed implementation.

1. **Composition:** exercise the actual host with the packed plugin, stylesheet,
   islands and core embeds. Isolated SDK renders and synthetic app HTML prove
   only their own contracts. Built-in templates are part of the same inventory.
2. **Transitions:** load, scroll into/out of pinned states, open/close, select,
   edit/revert, save/reload and back/forward. Check before hydration and after
   async content settles where they matter. Preserve session state for journeys;
   a harness clearing storage on every navigation cannot verify recovery.
3. **Boundary data:** empty, one and many items; long Bangla labels; RTL;
   missing/portrait/wide media; unavailable SKUs; slow, rejected and conflicting
   responses. Use a local backend for order, payment and fault-injection tests.
4. **Combinations:** sample interacting pairs, then explicitly test high-risk
   triples and sequences. Mandatory examples: plugin header + product bars +
   scroll; RTL + overflowing tabs + narrow viewport; existing cart + Buy now +
   interrupted checkout; edit + revert + navigation. Pairwise coverage alone is
   not proof. Use real breakpoints and short heights, not just device labels.
5. **Independent review:** give the reviewer requirements, contracts and failing
   evidence before the proposed fix. Ask for counterexamples and inspect a
   sample of passing states. Opus or another reviewer is judgment, not execution
   evidence; reject advice that contradicts the user's required behavior.

## Check outcomes, not implementation resemblance

| Property | Required observation |
| --- | --- |
| Geometry and input | Intended controls are visible and receive pointer/keyboard input; content bars clear actual sticky obstruction. Check declared layers, not a blanket ban on intersecting rectangles: overlays and nested containers intentionally overlap. |
| Anchors and focus | The selected section and focused control are visible after navigation. Modal focus is contained, Escape and dismissal restore focus, and scroll lock is released. Nonmodal popovers follow their own semantics. |
| Media and density | Fit-mode previews show the whole asset without distortion. Empty and dense states retain understandable actions and manageable scrolling. |
| Data continuity | Selectors, cart lines, draft changes and recovery identity survive the transitions they promise. No unrelated data is removed or restored. |
| Commerce truth | Compare amounts for the same SKU, quantity, market, address and quote revision. Product estimates need not equal a later address-specific quote; the distinction must be clear. |
| Failure and recovery | Failure has an actionable next step; retries do not duplicate orders, payments or reservations. Success requires authoritative confirmation. |
| Merchant editing | Edit/revert returns to clean; failed saves preserve edits; save/reload preserves accepted values; conflicts are explicit; preview and published output agree on the saved revision. |
| Runtime costs | Measure production output and preserve existing API/D1, script, asset and rendering budgets. Gallery dev timing is not production performance evidence. |

A click promise resolving, a DOM node existing or a CSS class appearing is not
proof of the intended state. Required actions must reach explicit postconditions.
Missing targets, failed actions and missing audit regions fail verification;
explicitly excluded viewports are not applicable, never counted as passed.
Screenshots complement geometry, semantics and state assertions; none replaces
the others. Static accessibility checks do not establish full accessibility.

Budget viewport space for the user's task, including the active theme's header,
bottom navigation, safe areas and editor chrome. Long content may scroll; routine
actions should not require scrolling through it. Check short heights as well as
narrow widths: release sticky chrome when it crowds out reading, and keep one
clear scroll owner per work pane. A fixed height that merely hides overflow is
not a solution. Verify this shared contract across core templates and plugins.

## Completion and evidence

For a meaningful fix, reproduce the failure on the old behavior, verify the
corrected behavior, check affected consumers, and inspect the deployed composition
when runtime code changes. A source-only hypothesis remains unverified.

Keep one bounded run artifact with scenario IDs, expected and actual outcomes,
environment/build/plugin identities, step screenshots, relevant measurements,
commands and exclusions. Use `passed`, `failed`, `not-run`, `blocked`, and
`not-applicable`. Report **executed scenarios / planned scenarios**, failing
scenarios and untested dimensions separately from unit-test counts. One browser
viewport is not a real-device result; preview evidence is not published evidence.

Open defects belong in the repository issue tracker; run artifacts are dated
evidence, not a second permanent backlog. Estimate the remaining named work after
the first representative run exposes fixture/setup cost and defect rate. Never
convert passing checks into a percentage of unknown bugs eliminated.

## First integration sweep

Use these as scenario families, expanded only where dimensions interact. They
are required scope to investigate, **not a claim that they currently pass**:

1. Noor product: scroll, tabs, section navigation, buy bar and gallery; desktop,
   phone and resize while scrolled; preview and published.
2. Every built-in header family with those core sticky consumers; header off,
   announcement changes, long navigation and relevant breakpoint boundaries.
3. Noor home: hero-first versus content-first, menus/search, slideshow, normal
   and reduced motion, absent media and empty/dense content.
4. Noor/core listing and cart: filtering, paging, quick add, empty/one/many lines,
   unavailable variants and quote changes.
5. Campaign pages: absent, repeated or ineligible order forms, anchor identity,
   mobile order bar and safe product/checkout fallbacks.
6. Commerce: Add A → Buy B → checkout A+B; refresh/back, lost response, conflict,
   pending order, account switch and receipt recovery against a local backend.
7. Builder: preset → edit/revert → reorder/hide → undo/redo → save/reload →
   publish; inspect real preview messages and buyer output, including delayed
   responses and plugin update/deactivation fallback. Collapse/reopen notices
   with a part selected; verify toolbar hit targets, refresh persistence and
   the way back to the draft when a historical preview fails. Section-library
   browsing and cancellation must leave draft/history unchanged; inspect real
   core/app previews and confirm one Add/Undo. On touch, distinguish grip drag,
   tap, row swipe and cancelled drag, including hybrid pointer devices. Measure
   canvas scrolling separately from edit-to-preview latency; development render
   counts are not production timing claims.
8. Merchant forms, rich text and media: normalize/revert, failed save, keyboard,
   fullscreen, portrait/panorama and dense/sparse lists.
9. Notifications: empty/few/many, unread/read/clear, arrival during an overlay,
   foreground/background delivery and separately evidenced native device sound.

Use the [design decision process](../apps/admin-v2/DESIGN.md#design-decisions)
before redesigning a flow: research relevant strong interfaces, compare them
against the task, then validate the chosen approach here. Competitor research
does not establish the correctness of our implementation.
