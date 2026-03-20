/**
 * Scopes CSS selectors under a unique wrapper class to prevent widget styles
 * from leaking into the rest of the page.
 *
 * Given raw CSS and a scope class (e.g. "sw-abc123"), every selector is
 * prefixed so `.btn { color: red }` becomes `.sw-abc123 .btn { color: red }`.
 *
 * Handles:
 * - Regular selectors (`.foo`, `#bar`, `div`)
 * - Comma-separated selector lists
 * - `@media` / `@supports` / `@layer` at-rules (prefixes inner selectors)
 * - `body` / `html` / `*` selectors → rewritten to the scope class
 * - `@keyframes`, `@font-face` → passed through unchanged
 * - Nested `@media` inside other at-rules
 */
export function scopeCss(css: string, scopeClass: string): string {
  if (!css || !scopeClass) return css;

  const scope = `.${scopeClass}`;
  return processBlock(css, scope);
}

function processBlock(css: string, scope: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < css.length) {
    // Skip whitespace
    if (/\s/.test(css[i])) {
      result.push(css[i]);
      i++;
      continue;
    }

    // Skip comments
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        result.push(css.slice(i));
        break;
      }
      result.push(css.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    // At-rule
    if (css[i] === "@") {
      const atRule = extractAtRule(css, i);
      if (!atRule) {
        result.push(css[i]);
        i++;
        continue;
      }

      const name = atRule.name.toLowerCase();

      // Pass-through at-rules: don't prefix selectors inside these
      if (name === "keyframes" || name === "-webkit-keyframes" || name === "font-face") {
        result.push(css.slice(i, atRule.end));
        i = atRule.end;
        continue;
      }

      // Conditional at-rules: prefix selectors inside the block
      if (name === "media" || name === "supports" || name === "layer" || name === "container") {
        result.push(css.slice(i, atRule.bodyStart));
        result.push(processBlock(css.slice(atRule.bodyStart, atRule.bodyEnd), scope));
        result.push("}");
        i = atRule.end;
        continue;
      }

      // Other at-rules (e.g. @import, @charset) — pass through
      if (atRule.bodyStart === -1) {
        result.push(css.slice(i, atRule.end));
        i = atRule.end;
        continue;
      }

      // Unknown block at-rule — pass through
      result.push(css.slice(i, atRule.end));
      i = atRule.end;
      continue;
    }

    // Regular rule: selector { ... }
    const openBrace = findTopLevelChar(css, "{", i);
    if (openBrace === -1) {
      // No more rules, treat remainder as-is
      result.push(css.slice(i));
      break;
    }

    const closeBrace = findMatchingBrace(css, openBrace);
    if (closeBrace === -1) {
      result.push(css.slice(i));
      break;
    }

    const selectorText = css.slice(i, openBrace).trim();
    const body = css.slice(openBrace, closeBrace + 1);

    if (selectorText) {
      result.push(prefixSelectors(selectorText, scope));
      result.push(" ");
      result.push(body);
    } else {
      result.push(css.slice(i, closeBrace + 1));
    }

    i = closeBrace + 1;
  }

  return result.join("");
}

function prefixSelectors(selectorText: string, scope: string): string {
  return selectorText
    .split(",")
    .map((sel) => {
      const s = sel.trim();
      if (!s) return s;

      // Rewrite global selectors to the scope container itself
      if (s === "body" || s === "html" || s === "*" || s === ":root") {
        return scope;
      }

      // Selectors starting with body/html — strip the global part and scope
      if (/^(body|html)\s+/.test(s)) {
        return `${scope} ${s.replace(/^(body|html)\s+/, "")}`;
      }

      return `${scope} ${s}`;
    })
    .join(", ");
}

interface AtRuleInfo {
  name: string;
  /** Index right after the opening `{` (first char inside the block) */
  bodyStart: number;
  /** Index right after the opening `{` — -1 if no block (e.g. `@import`) */
  bodyEnd: number;
  /** Index one past the closing `}` or semicolon */
  end: number;
}

function extractAtRule(css: string, start: number): AtRuleInfo | null {
  // Match the at-rule name
  const nameMatch = css.slice(start).match(/^@([\w-]+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];

  // Find either { or ; to determine if it's a block or statement at-rule
  let j = start + nameMatch[0].length;
  while (j < css.length) {
    if (css[j] === "{") {
      const bodyStart = j + 1;
      const closeBrace = findMatchingBrace(css, j);
      if (closeBrace === -1) return null;
      return { name, bodyStart, bodyEnd: closeBrace, end: closeBrace + 1 };
    }
    if (css[j] === ";") {
      return { name, bodyStart: -1, bodyEnd: -1, end: j + 1 };
    }
    j++;
  }

  return null;
}

function findTopLevelChar(css: string, char: string, start: number): number {
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    if (depth === 0 && css[i] === char) return i;
  }
  return -1;
}

function findMatchingBrace(css: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
