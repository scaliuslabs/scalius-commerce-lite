# Navigation Tree Drag Interaction

Last reviewed: 2026-07-14

Status: accepted interaction contract; implementation and live verification in
progress.

## Why the previous interaction failed

The July 2026 builder inferred hierarchy almost entirely from horizontal drag
distance. A deeply nested item therefore had to travel through several narrow,
invisible depth lanes before it could return to the root. Vertical placement,
parent selection, and outdent were coupled into one gesture, so the pointer
could be visibly near the intended row while the projected parent remained
surprising. Replacing the source row with explanatory placeholder copy also
removed the strongest visual anchor.

This was data-safe, but not merchant-usable.

## Research decisions

The replacement combines the clearest parts of Shopify's menu model, dnd-kit's
official sortable-tree example, Atlassian's production tree guidance, and the
existing Scalius Contact & Social reorder interaction:

- keep an always-visible drag handle;
- leave the original row in place at `40%` opacity and move a compact drag
  preview, so the source and cancel destination remain obvious;
- keep every non-dragged branch visible; only descendants travelling with an
  expanded dragged branch may collapse temporarily;
- divide a target row into three generous operations: top quarter is **before**,
  middle half is **inside**, and bottom quarter is **after**;
- show a 2px line with a terminal for before/after and a full-row selected
  treatment for inside. Never use the same visual for both meanings;
- make `inside` expand a collapsed target after a 500ms dwell and always leave
  the moved item visible after drop;
- treat a branch as one atomic unit and block self/descendant cycles and any
  move that exceeds the three-level storefront limit;
- do not require a horizontal precision gesture to outdent. Dropping before or
  after a shallower row adopts that row's parent level;
- provide a permanent **Move** action on every row. Its dialog selects Parent
  and Position and can express every valid result without dragging;
- announce the item, destination parent, and resulting position; restore focus
  to the moved row/action when possible;
- test pointer geometry in a real browser because mocked DOM rectangles do not
  prove collision behavior.

## Operation semantics

| Pointer region | Result | Visual |
| --- | --- | --- |
| Top 25% of a row | Before that item as its sibling | Line above |
| Middle 50% | Last child of that item | Highlighted row / inside label |
| Bottom 25% | After that item as its sibling | Line below |

`After` means after the target's complete branch at the target's own parent
level. `Inside` is the only pointer operation that creates a child. This avoids
the common ambiguity where dropping below an expanded parent unexpectedly
becomes its first child.

## Non-drag fallback

The Move dialog is not a secondary workaround. It is the exact-placement and
assistive-technology path for large menus:

1. choose Top level or any valid non-descendant parent;
2. choose a one-based position among that parent's children;
3. preview the resulting level and parent;
4. apply one atomic move or cancel without mutating the draft.

Directional button chains are not the primary fallback for a tree: they are
slow, difficult to describe to screen readers, and require many actions for a
deep cross-parent move.

## Scale and safety

- Render no more than the current bounded outline batch and never mount hidden
  collapsed descendants just to support drag.
- Search disables structural dragging because a filtered outline is not a
  truthful placement surface; Move remains available against the complete
  hierarchy.
- Auto-scroll must preserve the preview and destination indicator inside the
  focused menu surface.
- A failed, cancelled, invalid, or off-surface drop leaves the menu unchanged.
- Saving remains explicit and revision guarded; drag only updates the local
  settings draft.

## Verification matrix

Verify at minimum:

- sibling reorder at root and at every supported level;
- root to child, child to root, level three to level one, and cross-parent move;
- complete branch moves, cycle rejection, and depth-limit rejection;
- collapsed-target dwell expansion and post-drop visibility;
- pointer cancellation, scrolling, narrow viewport, keyboard/Move dialog, and
  focus restoration;
- no disappearing unrelated rows, no ambiguous indicator, no console error,
  and no save until the merchant presses the settings Save action.

## Primary sources

- [Shopify Help, “Add, remove, or edit menu items in your online store”](https://help.shopify.com/en/manual/online-store/menus-and-links/editing-menus)
  (resource-linked menu destinations, handle reorder, explicit save).
- [dnd-kit official repository and `SortableTree` example](https://github.com/clauderic/dnd-kit)
  (flat projection,
  branch-aware overlay, bounded depth, keyboard sensor, announcements).
- [Atlassian Pragmatic drag and drop design guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines/)
  and [accessibility guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines/)
  (40% source opacity, line versus background semantics, tree hitboxes,
  500ms expansion, and complete Move dialog alternative).
