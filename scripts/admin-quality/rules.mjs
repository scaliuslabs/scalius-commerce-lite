// The rules of the dashboard quality harness: one stable id each, and whether
// a finding fails the run (gating) or is a number to bring down (advisory).
// docs/ADMIN-QUALITY.md lists them; `rules.test.mjs` keeps the two in step.

export const RULES = Object.freeze({
  render: { gating: true, impact: "critical", what: "The page shows the error or not-found screen, or the document answers 4xx/5xx" },
  "blank-page": { gating: true, impact: "critical", what: "The page settles with no content in main" },
  "load-stuck": { gating: true, impact: "serious", what: "A skeleton or busy state is still on screen after 15 s" },
  "overflow-page": { gating: true, impact: "serious", what: "The page scrolls sideways, or content is cut off at the edge" },
  "overflow-container": { gating: true, impact: "serious", what: "A card or table is wider than the box that holds it" },
  "leaked-value": { gating: true, impact: "serious", what: "A raw translation key, ICU syntax, undefined, NaN, [object Object] or Invalid Date is visible" },
  "page-error": { gating: true, impact: "serious", what: "An uncaught script error" },
  "network-5xx": { gating: true, impact: "serious", what: "A request answered 5xx (outside the expected list)" },
  axe: { gating: true, impact: "serious", what: "axe-core WCAG 2.2 AA; gating for serious and critical, advisory for the rest (rule id is the axe id)" },
  "table-scroll": { gating: false, impact: "moderate", what: "A table scrolls sideways inside its card" },
  "clipped-text": { gating: false, impact: "moderate", what: "Text is cut off with no ellipsis (scrollWidth above clientWidth under overflow hidden)" },
  "truncated-no-title": { gating: false, impact: "moderate", what: "Text is truncated (ellipsis or line clamp) with no title, label or tooltip carrying the full value" },
  "control-height": { gating: false, impact: "moderate", what: "Inputs, selects, comboboxes or buttons in one row or form section differ in height by more than 1 px" },
  "field-misaligned": { gating: false, impact: "moderate", what: "Fields stacked in one form column start more than 1 px apart" },
  "wrong-language": { gating: false, impact: "moderate", what: "English interface text in the Bangla dashboard (heuristic with an allowlist)" },
  "html-lang": { gating: false, impact: "moderate", what: "The html lang or dir does not match the dashboard language" },
  "console-error": { gating: false, impact: "minor", what: "The page logged an error to the console" },
  "network-error": { gating: false, impact: "moderate", what: "A request answered 4xx or failed (outside the expected list)" },
  "layout-shift": { gating: false, impact: "moderate", what: "CLS above 0.1 over the load plus 3 s" },
  "load-first-render": { gating: false, impact: "moderate", what: "First contentful paint later than 1 s" },
  "load-settled": { gating: false, impact: "moderate", what: "Content (no skeleton) settled later than 1 s" },
  "skeleton-shape": { gating: false, impact: "moderate", what: "The skeleton and the final content differ a lot in height" },
  "interaction-latency": { gating: false, impact: "moderate", what: "A named interaction shows no visual response within 100 ms" },
  "focus-visible": { gating: false, impact: "serious", what: "A control looks the same focused and unfocused (WCAG 2.4.7)" },
  "focus-trap": { gating: false, impact: "serious", what: "Tab stays on one element, loses focus, or leaves an open dialog" },
  redirected: { gating: false, impact: "minor", what: "The route ended on another address" },
});

/** Impact and gating of a finding by rule id; axe ids come from axe itself. */
export function isGating(finding) {
  if (finding.source === "axe") return finding.impact === "serious" || finding.impact === "critical";
  return Boolean(RULES[finding.rule]?.gating);
}
