// The phone tab bar's numbers (private-tab-bar.ts checks and writes its look by them): data only, read by the anatomy
// (which prints the bar's own bounds and choices) and sealed in the contract's limits (plugins/app-limits.ts).

/**
 * The bar's sealed numbers (contract-tables `limits`, each loosening only): how much of what lies under a blurred
 * bar shows through it (the store's: its colour at 94%), a label's least size, and what tells the current tab apart
 * from the others by more than its hue (WCAG 1.4.1, technique G183: a cue besides colour that reads 3:1): its words
 * at least `wordsApart` from theirs, a ring at least `ringWidth` wide reading 3:1 on the bar, a weight at least
 * `weightStep` heavier, or a chip `chipStep` px larger than theirs, both chips drawn.
 */
export const PRIVATE_TAB_BAR_LIMITS = { blurBleed: 0.06, labelMinSize: 10, wordsApart: 3, ringWidth: 2, weightStep: 200, chipStep: 4 } as const;

/** The bar's own choices, where they differ from a token's everywhere else: a label's lines (`clamp`) are one or two. */
export const PRIVATE_TAB_BAR_CHOICES = { "label.clamp": ["1", "2"] } as const satisfies Record<string, readonly string[]>;

/** The bar's own bounds (px), where they differ from a token's everywhere else. */
export const PRIVATE_TAB_BAR_BOUNDS = {
  "bar.height": [56, 96],
  // A label's floor: 10px, a phone tab bar's own label size (a page's words keep 12px). Below it a label is not read.
  "label.size": [PRIVATE_TAB_BAR_LIMITS.labelMinSize, 16],
  "icon.size": [16, 32],
  "icon.padding": [0, 16],
  "icon.radius": [0, 32],
  "icon.border-width": [0, 2],
  "current.padding": [0, 16],
  "current.ring-width": [0, 4],
} as const satisfies Record<string, readonly [number, number]>;

/** The store's own bar, the defaults a token replaces. */
export const PRIVATE_TAB_BAR_DEFAULTS = { height: 60, labelSize: 12, labelWeight: 500, currentWeight: 700, iconSize: 22, gap: 3 } as const;

/**
 * A label's line height, and the room above and below its lines (em) inside its box: Bangla's vowel signs reach
 * past a Latin line, and the label's box clips (its lines are clamped), so the room is part of the label.
 */
export const PRIVATE_TAB_BAR_LABEL = { leading: 1.25, room: 0.15 } as const;
