// The rules of the dashboard quality harness: one stable id each, whether a
// finding fails the run (gating) or is a number to bring down (advisory), and
// the rule of "The polish bar" in apps/admin-v2/DESIGN.md it checks (`polish`).
// docs/ADMIN-QUALITY.md lists them; `analysis.test.mjs` keeps the two in step.
//
// Geometry and copy-leak rules gate. Heuristics (and timing) stay advisory
// until the shared components carry the `data-slot` names (Wave B).

export const RULES = Object.freeze({
  render: { gating: true, impact: "critical", polish: ["R1"], what: "The page shows the error or not-found screen, or the document answers 4xx/5xx" },
  "blank-page": { gating: true, impact: "critical", polish: ["L1"], what: "The page settles with no content in main" },
  "load-stuck": { gating: true, impact: "serious", polish: ["L1"], what: "A skeleton or busy state is still on screen after 15 s" },
  "overflow-page": { gating: true, impact: "serious", polish: ["N2"], what: "The page or the main scroller scrolls sideways, or content is cut off at the edge" },
  "overflow-container": { gating: true, impact: "serious", polish: ["N2"], what: "A card or table is wider than the box that holds it" },
  "leaked-value": { gating: true, impact: "serious", polish: ["Y1"], what: "A raw translation key, ICU syntax, undefined, NaN, [object Object] or Invalid Date is visible" },
  "page-error": { gating: true, impact: "serious", polish: [], what: "An uncaught script error" },
  "network-5xx": { gating: true, impact: "serious", polish: ["R1"], what: "A request answered 5xx (outside the expected list)" },
  axe: { gating: true, impact: "serious", polish: [], what: "axe-core WCAG 2.2 AA; gating for serious and critical, advisory for the rest (rule id is the axe id)" },
  "clipped-text": { gating: true, impact: "moderate", polish: ["N1"], what: "Text is cut off with no ellipsis (scrollWidth above clientWidth under overflow hidden)" },
  "truncated-no-title": { gating: true, impact: "moderate", polish: ["T7"], what: "Text is truncated (ellipsis or line clamp) with no title, label or tooltip carrying the full value" },
  "label-truncated": { gating: true, impact: "moderate", polish: ["N3"], what: "A button, tab, label or heading is wider than its box" },
  "control-height": { gating: true, impact: "moderate", polish: ["C2"], what: "Inputs, selects, comboboxes or buttons in one row or form section differ in height by more than 1 px" },
  "control-size": { gating: true, impact: "moderate", polish: ["C1"], what: "An input, textarea or combobox is not 36 px tall (44 px below 640 px wide)" },
  "touch-target": { gating: true, impact: "moderate", polish: ["C6"], what: "A button, link, checkbox, switch, radio or tab is under 24x24 px, or under 44 px tall below 640 px" },
  "multiple-primary": { gating: true, impact: "moderate", polish: ["C3"], what: "More than one primary button in the page, or in one open dialog" },
  "dialog-stack": { gating: true, impact: "moderate", polish: ["O2"], what: "Two dialogs are open at once" },
  "row-height": { gating: true, impact: "moderate", polish: ["T3"], what: "Rows of one table differ in height by more than 1 px" },
  "numeric-align": { gating: true, impact: "moderate", polish: ["T5"], what: "A numeric column is not end-aligned with tabular digits" },
  "unit-in-label": { gating: true, impact: "moderate", polish: ["F3"], what: "A label carries its unit in brackets, such as \"Price (৳)\"" },
  "label-gap": { gating: true, impact: "moderate", polish: ["S2"], what: "A label is not 4 px (±1) above its control" },
  "help-gap": { gating: true, impact: "moderate", polish: ["S3"], what: "Help or error text is not 4 px (±1) under its control" },
  "focus-return": { gating: true, impact: "serious", polish: ["Q2"], what: "Esc closes a surface but focus does not return to its trigger" },
  "table-scroll": { gating: false, impact: "moderate", polish: ["N2"], what: "A table scrolls sideways inside its card" },
  "field-misaligned": { gating: false, impact: "moderate", polish: ["S5", "S7"], what: "Fields stacked in one form column start more than 1 px apart" },
  "dialog-width": { gating: false, impact: "minor", polish: ["O1"], what: "A dialog is not 448 (sheet), 512, 640 or 800 px wide from 640 px" },
  "row-link": { gating: false, impact: "minor", polish: ["T15"], what: "No row of a table opens by a real link" },
  "wrong-language": { gating: false, impact: "moderate", polish: ["Y5"], what: "English interface text in the Bangla dashboard (heuristic with an allowlist)" },
  "html-lang": { gating: false, impact: "moderate", polish: ["Y5"], what: "The html lang or dir does not match the dashboard language" },
  "console-error": { gating: false, impact: "minor", polish: [], what: "The page logged an error to the console" },
  "network-error": { gating: false, impact: "moderate", polish: ["R1"], what: "A request answered 4xx or failed (outside the expected list)" },
  "layout-shift": { gating: false, impact: "moderate", polish: ["L2"], what: "CLS above 0.1 over the load plus 3 s" },
  "load-first-render": { gating: false, impact: "moderate", polish: ["L1"], what: "First contentful paint later than 1 s" },
  "load-settled": { gating: false, impact: "moderate", polish: ["L1"], what: "Content (no skeleton) settled later than 1 s" },
  "skeleton-shape": { gating: false, impact: "moderate", polish: ["L2"], what: "The skeleton and the final content differ a lot in height" },
  "interaction-latency": { gating: false, impact: "moderate", polish: ["M1"], what: "A named interaction shows no visual response within 100 ms" },
  "focus-visible": { gating: false, impact: "serious", polish: ["Q1"], what: "A control looks the same focused and unfocused (WCAG 2.4.7)" },
  "focus-obscured": { gating: false, impact: "serious", polish: ["Q1"], what: "A focused control in main sits under the top bar" },
  "focus-trap": { gating: false, impact: "serious", polish: ["Q1"], what: "Tab stays on one element, loses focus, or leaves an open dialog" },
  redirected: { gating: false, impact: "minor", polish: [], what: "The route ended on another address" },
});

/** Polish-bar rules that an axe rule enforces. */
export const AXE_POLISH = Object.freeze({ "button-name": ["C7"], "target-size": ["C6"] });

/** Polish-bar rules of DESIGN.md that are not automated yet (docs/ADMIN-QUALITY.md lists them). */
export const NOT_AUTOMATED = Object.freeze(["S4", "S5", "S6", "S7", "S8", "S9", "F8", "C4", "T4", "T6", "T8", "T9", "T10", "T12", "T13", "P2", "P4", "O1 (needs the dialog-content slot)", "E1", "E2", "L1 (cold load with a delayed API)", "L2 (skeleton CLS with a delayed API)", "L3", "L4", "R1 (mocked read failure)", "R2", "R3", "R5", "R6", "M1 (delayed mutation)", "Q2 (global shortcuts)", "W1", "W2", "W4", "N5", "X1"]);

/** Rule ids of the polish bar a finding breaks. */
export function polishIds(finding) {
  if (finding.source === "axe") return AXE_POLISH[finding.rule] ?? [];
  return RULES[finding.rule]?.polish ?? [];
}

/** Impact and gating of a finding by rule id; axe ids come from axe itself. */
export function isGating(finding) {
  if (finding.source === "axe") return finding.impact === "serious" || finding.impact === "critical";
  return Boolean(RULES[finding.rule]?.gating);
}
