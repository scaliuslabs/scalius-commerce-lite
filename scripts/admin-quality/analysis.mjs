// The judgments of the dashboard quality harness: pure functions over the
// facts that scripts/admin-quality/page-facts.mjs collects in the browser, so
// the rules run on fixtures in unit tests without a browser.

// ─── Clipped text ───────────────────────────────────────────────────────────

const CLIP_SLACK = 2; // sub-pixel rounding and italic overhang

/**
 * A node whose text does not fit its box.
 *   fact: { sw, cw, sh, ch, overflowX, overflowY, textOverflow, lineClamp,
 *           hasFullValue, srOnly }
 * Returns null (fits, scrolls, or is hidden on purpose), or
 *   { rule: "clipped-text" }        text cut with no ellipsis: a reader loses words
 *   { rule: "truncated-no-title" }  ellipsis or line clamp with no accessible full value
 */
export function classifyClip(fact) {
  if (fact.srOnly) return null;
  const clipsX = /^(hidden|clip)$/.test(fact.overflowX) && fact.sw > fact.cw + CLIP_SLACK;
  const clipsY = /^(hidden|clip)$/.test(fact.overflowY) && fact.sh > fact.ch + CLIP_SLACK;
  const clamped = Boolean(fact.lineClamp) && fact.sh > fact.ch + CLIP_SLACK;
  if (!clipsX && !clipsY && !clamped) return null;
  const intended = fact.textOverflow === "ellipsis" || Boolean(fact.lineClamp);
  if (intended) return fact.hasFullValue ? null : { rule: "truncated-no-title" };
  return { rule: "clipped-text" };
}

// ─── Control heights and field alignment ────────────────────────────────────

const HEIGHT_TOLERANCE = 1;
const ALIGN_TOLERANCE = 1;
// Fields whose left edges lie within this distance are one column that did not
// line up; further apart they are separate columns.
const SAME_COLUMN_WITHIN = 24;
const FIELD_KINDS = new Set(["input", "select", "combobox"]);

const centerY = (control) => control.y + control.h / 2;
const overlapsRow = (a, b) => Math.abs(centerY(a) - centerY(b)) <= Math.min(a.h, b.h) / 2;

/**
 * Controls of one form section or row at different heights.
 *   control: { id, kind: input|select|combobox|button, section, x, y, w, h, iconOnly }
 * Two checks: fields in one section share a height (a 36px input beside a 40px
 * one), and the controls of one row (fields and text buttons) share a height.
 * Icon-only buttons are square by design and skip the row check.
 */
export function controlHeightFindings(controls) {
  const findings = [];
  const bySection = new Map();
  for (const control of controls) {
    if (!bySection.has(control.section)) bySection.set(control.section, []);
    bySection.get(control.section).push(control);
  }
  for (const group of bySection.values()) {
    const fields = group.filter((control) => FIELD_KINDS.has(control.kind));
    const heights = fields.map((control) => control.h);
    if (fields.length > 1 && Math.max(...heights) - Math.min(...heights) > HEIGHT_TOLERANCE) {
      const tallest = Math.max(...heights);
      findings.push({
        scope: "section",
        message: `Fields of one section have different heights (${[...new Set(heights.map((h) => Math.round(h * 10) / 10))].join(", ")}px).`,
        nodes: fields.filter((control) => control.h < tallest - HEIGHT_TOLERANCE).map((control) => `${control.id} (${Math.round(control.h)}px)`).slice(0, 10),
      });
    }
    // Rows: controls whose vertical centres line up.
    const rowControls = group.filter((control) => !control.iconOnly).sort((a, b) => a.y - b.y || a.x - b.x);
    const used = new Set();
    for (const [index, control] of rowControls.entries()) {
      if (used.has(index)) continue;
      const row = [control];
      for (let next = index + 1; next < rowControls.length; next += 1) {
        if (!used.has(next) && overlapsRow(control, rowControls[next])) {
          row.push(rowControls[next]);
          used.add(next);
        }
      }
      if (row.length < 2) continue;
      const rowHeights = row.map((item) => item.h);
      if (Math.max(...rowHeights) - Math.min(...rowHeights) > HEIGHT_TOLERANCE) {
        findings.push({
          scope: "row",
          message: `Controls in one row have different heights (${[...new Set(rowHeights.map((h) => Math.round(h)))].join(", ")}px).`,
          nodes: row.map((item) => `${item.id} (${Math.round(item.h)}px)`).slice(0, 10),
        });
      }
    }
  }
  return findings;
}

/**
 * Fields of one form section whose left edges almost line up but not quite.
 *   field: { id, section, x, y, w, h }
 */
export function fieldAlignmentFindings(fields) {
  const findings = [];
  const bySection = new Map();
  for (const field of fields) {
    if (!bySection.has(field.section)) bySection.set(field.section, []);
    bySection.get(field.section).push(field);
  }
  for (const group of bySection.values()) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    let cluster = [];
    const flush = () => {
      if (cluster.length > 1) {
        // Fields side by side are columns; only fields stacked on top of each other must align.
        const stacked = cluster.filter((field) => cluster.some((other) => other !== field && !overlapsRow(field, other)));
        const lefts = stacked.map((field) => field.x);
        if (stacked.length > 1 && Math.max(...lefts) - Math.min(...lefts) > ALIGN_TOLERANCE) {
          const base = Math.min(...lefts);
          findings.push({
            message: `Fields in one form column start ${(Math.max(...lefts) - base).toFixed(1)}px apart.`,
            nodes: stacked.filter((field) => field.x - base > ALIGN_TOLERANCE).map((field) => `${field.id} (left ${field.x.toFixed(1)}px)`).slice(0, 10),
          });
        }
      }
      cluster = [];
    };
    for (const field of sorted) {
      if (cluster.length && field.x - cluster[cluster.length - 1].x > SAME_COLUMN_WITHIN) flush();
      cluster.push(field);
    }
    flush();
  }
  return findings;
}

// ─── Label and help gaps (S2, S3) ───────────────────────────────────────────

const STACK_GAP = 4;
const STACK_GAP_TOLERANCE = 1;
const STACK_GAP_MAX = 48; // further apart, the two are not one field's stack

/**
 * A label 4px above its control, and help or error text 4px under it.
 *   pair: { id, kind: "label" | "help", above: box, below: box }, box: { left, right, top, bottom }
 * For "label" the label is above; for "help" the control is above. A pair that
 * does not overlap horizontally sits side by side (a checkbox and its text, a
 * switch at the row's end), and a label under its control is a checkbox's; both
 * have no stack gap to judge.
 * Returns the messages: { label: [...], help: [...] }, at most 10 each.
 */
export function stackGapFindings(pairs) {
  const found = { label: [], help: [] };
  for (const { id, kind, above, below } of pairs) {
    if (!(above.left < below.right && below.left < above.right)) continue;
    if (above.bottom > below.top + STACK_GAP_TOLERANCE) continue;
    const gap = below.top - above.bottom;
    if (gap >= STACK_GAP_MAX || Math.abs(gap - STACK_GAP) <= STACK_GAP_TOLERANCE) continue;
    const shown = Math.round(gap * 10) / 10;
    found[kind].push(kind === "label" ? `${id} (${shown}px under its label)` : `${id} (${shown}px above its help)`);
  }
  return { label: found.label.slice(0, 10), help: found.help.slice(0, 10) };
}

// ─── Leaked values ──────────────────────────────────────────────────────────

const FILE_AND_DOMAIN_ENDINGS = new Set([
  "com", "net", "org", "io", "co", "bd", "dev", "app", "test", "local", "shop", "store", "md", "js", "ts", "json", "png", "jpg",
  "jpeg", "webp", "svg", "gif", "pdf", "csv", "txt", "xml", "html", "css", "mp4", "mjs", "tsx", "ico", "zip",
]);

const LEAK_PATTERNS = [
  { kind: "icu", test: (text) => /\{\s*\w+\s*,\s*(plural|select|selectordinal)\b/.test(text), label: "ICU syntax" },
  { kind: "placeholder", test: (text) => /(?<!\{)\{\s*[A-Za-z_]\w*\s*\}(?!\})/.test(text), label: "an unfilled {placeholder}" },
  { kind: "undefined", test: (text) => /\bundefined\b/.test(text), label: "undefined" },
  { kind: "nan", test: (text) => /\bNaN\b/.test(text), label: "NaN" },
  { kind: "infinity", test: (text) => /(^|[^A-Za-z])-?Infinity\b/.test(text), label: "Infinity" },
  { kind: "object", test: (text) => /\[object \w+\]/.test(text), label: "[object Object]" },
  { kind: "invalid-date", test: (text) => /Invalid (Date|time)/i.test(text), label: "Invalid Date" },
  {
    kind: "i18n-key",
    label: "a raw translation key",
    test: (text) => {
      const trimmed = text.trim();
      if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,}$/.test(trimmed)) return false;
      return !FILE_AND_DOMAIN_ENDINGS.has(trimmed.split(".").pop());
    },
  },
];

/**
 * Raw keys, ICU syntax and other values that must never reach a person.
 *   item: { text, sel, code } -- `code` marks text in code, kbd, samp and pre.
 */
export function findLeaks(items) {
  const leaks = [];
  for (const item of items) {
    if (!item.text) continue;
    for (const pattern of LEAK_PATTERNS) {
      if (item.code && pattern.kind !== "icu" && pattern.kind !== "object") continue;
      if (pattern.test(item.text)) {
        leaks.push({ kind: pattern.kind, label: pattern.label, text: item.text.trim().slice(0, 80), sel: item.sel });
        break;
      }
    }
  }
  return leaks;
}

// ─── Wrong language ─────────────────────────────────────────────────────────

const BENGALI = /[ঀ-৿]/;
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*/g;

export function compileLanguageAllowlist(raw) {
  return {
    terms: new Set((raw.terms ?? []).map((term) => term.toLowerCase())),
    phrases: (raw.phrases ?? []).map((phrase) => phrase.toLowerCase()),
    patterns: (raw.patterns ?? []).map((pattern) => new RegExp(pattern)),
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blank = (text, pattern) => text.replace(pattern, (match) => " ".repeat(match.length));

/** Latin words of a text that are neither allowlisted terms nor code-like tokens. */
export function englishWords(text, allow) {
  let rest = text;
  for (const phrase of allow.phrases) rest = blank(rest, new RegExp(escapeRegExp(phrase), "gi"));
  // Emails, addresses and paths are values, not sentences.
  rest = blank(rest, /\S+@\S+|https?:\/\/\S+|[\w-]+(\.[\w-]+)+(\/\S*)?|\/[\w/.-]+/g);
  const words = [];
  for (const match of rest.matchAll(LATIN_WORD)) {
    const source = match[0].replace(/^['’-]+|['’-]+$/g, "");
    const word = source.toLowerCase();
    if (word.length < 3) continue;
    if (allow.terms.has(word)) continue;
    const index = match.index ?? 0;
    // Tokens that carry digits or a capital in the middle are identifiers, not words.
    if (/\d/.test(rest.slice(Math.max(0, index - 1), index + match[0].length + 1))) continue;
    if (/[a-z][A-Z]/.test(source)) continue;
    if (allow.patterns.some((pattern) => pattern.test(source))) continue;
    words.push(word);
  }
  return words;
}

/**
 * English sentences and words in a Bangla page.
 *   item: { text, sel, data, code }; table cells and rich content (data) and code are not interface copy.
 */
export function findEnglishInBn(items, allow) {
  const found = [];
  for (const item of items) {
    if (item.data || item.code || !item.text) continue;
    const words = englishWords(item.text, allow);
    if (words.length === 0) continue;
    // Words in a text with no Bangla at all are only counted from two words up
    // or one longer word: a lone "Admin" is more often a name than a leak.
    if (!BENGALI.test(item.text) && words.length < 2 && words[0].length < 5) continue;
    found.push({ text: item.text.trim().slice(0, 80), sel: item.sel, words: words.slice(0, 5) });
  }
  return found;
}

// ─── Timing, layout shift, skeleton shape ───────────────────────────────────

export const THRESHOLDS = Object.freeze({
  firstRenderMs: 1000,
  settledMs: 1000,
  interactionMs: 100,
  cls: 0.1,
  skeletonShapeRatio: 0.35,
  skeletonShapeMinPx: 150,
});

/** A skeleton whose page is a different height from the content that replaced it. */
export function skeletonShapeFinding(skeletonHeight, finalHeight) {
  if (!skeletonHeight || !finalHeight) return null;
  const delta = Math.abs(finalHeight - skeletonHeight);
  const ratio = delta / Math.max(finalHeight, skeletonHeight);
  if (delta < THRESHOLDS.skeletonShapeMinPx || ratio < THRESHOLDS.skeletonShapeRatio) return null;
  return {
    message: `The loading skeleton is ${Math.round(skeletonHeight)}px tall and the content ${Math.round(finalHeight)}px: the page jumps ${Math.round(delta)}px when it settles.`,
    delta,
    ratio,
  };
}
