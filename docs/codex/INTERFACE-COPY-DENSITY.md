# Admin Interface Copy and Density Contract

Last reviewed: 2026-07-14

Status: accepted design rule for new work and incremental admin audits. This is
not permission for an indiscriminate dashboard-wide copy deletion.

## Decision

Visible interface copy must earn permanent space by helping the merchant make a
decision, satisfy a constraint, recover from a failure, or understand current
state. Repeated orientation, implementation detail, and one-time interaction
instruction do not belong in the resting interface.

Use four disclosure levels:

1. **Always visible:** labels, values, current state, task-critical constraints,
   validation, destructive consequences, and the next primary action.
2. **Contextual:** progress, warnings, drag/drop targets, conflicts, and recovery
   guidance shown only while that state exists.
3. **Supplemental:** brief nonessential context behind a focusable info affordance,
   tooltip, or disclosure. If it contains controls or links, use a disclosure or
   popover rather than a tooltip.
4. **Documentation:** concepts, examples, edge-case tutorials, and setup guides
   linked from the interface instead of repeated inside every card.

Tooltips must never contain information required to complete the task. Icon-only
actions require an accessible name and a concise hover/focus tooltip. Mobile and
keyboard users must receive the same meaning without hover.

## Page budget

- One page title. Add one short subtitle only when the title and navigation do
  not already establish scope.
- A primary section may have a short heading. Do not repeat the page subtitle in
  the section, tab, empty state, and card.
- A field always keeps its label. Add helper text only for a non-obvious format,
  consequence, or constraint; prefer one sentence and remove it when validation
  or a state message supersedes it.
- Resting tables and editors show data and actions. Interaction tutorials appear
  on first use, behind Help, or contextually during the interaction.
- Status copy is specific and temporary: `Moving Footwear before Home & Living`,
  not a permanent paragraph explaining every possible drag gesture.
- Empty states may explain the value of the first action once. Populated states
  should not retain onboarding prose.

## Density review

For each screen, read only its headings, subtitles, helper text, notices, and
status rows in order. Remove or demote a line when it answers the same question
as the line immediately above it. A compact screen fails review when merchants
must scan explanatory prose before they can see the data or primary action.

Do not optimize density by reducing type below the design-system readable size,
shrinking touch targets below 40px, removing field labels, or moving critical
instructions into hover-only UI.

## Navigation application

- The row handle and insertion line communicate reorder directly.
- The insertion line's indentation communicates the projected hierarchy.
- Static instructions live behind Help; live placement feedback appears only
  while dragging and clears after save/discard.
- Resource-link health, missing targets, and destructive subtree consequences
  remain visible because they affect correctness.
- Parent/position and keyboard move tools remain in a collapsed `Placement
  options` fallback, not in the primary resting surface.

## Verified references

- Shopify's current menu editor documents a visible drag handle and direct
  resource selection; the resource name is populated when a merchant has not
  supplied a custom name. <https://help.shopify.com/en/manual/online-store/menus-and-links/editing-menus>
- WordPress's current Navigation block uses a shifted insertion line to preview
  nesting and retains explicit moving tools as an alternative.
  <https://wordpress.org/documentation/article/navigation-block/>
- Carbon defines tooltips as contextual, helpful, and nonessential, explicitly
  rejects critical task instructions in tooltips, and recommends disclosures for
  interactive supplemental content.
  <https://carbondesignsystem.com/components/tooltip/usage/>
- Carbon's form guidance keeps pertinent completion help visible and uses
  tooltips only for additional context.
  <https://carbondesignsystem.com/components/form/usage/>
- Atlassian's content guidance favors clear, concise UI sentences and reserves
  tooltips for unavoidable truncation and icon-button accessibility.
  <https://atlassian.design/foundations/content/language-and-grammar>

