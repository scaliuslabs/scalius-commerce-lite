import type {
  Atrule,
  EnterOrLeaveFn,
  Identifier,
  Rule,
  SelectorList,
  StringNode,
  StyleSheet,
  WalkContext,
} from "css-tree";
import cssTree from "./css-tree-runtime";

const ALLOWED_BLOCK_AT_RULES = new Set([
  "container",
  "keyframes",
  "-webkit-keyframes",
  "layer",
  "media",
  "supports",
]);
const KEYFRAMES_AT_RULES = new Set(["keyframes", "-webkit-keyframes"]);
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B\u200C\u200D\uFEFF]/g;

/**
 * Scopes CSS selectors under a unique wrapper class to prevent widget styles
 * from leaking into the rest of the page.
 *
 * In addition to selector scoping, widget keyframes are renamed per scope and
 * animation declarations are rewritten to use those scoped names. At-rules are
 * default-deny: only conditional grouping rules and keyframes are retained.
 */
export function scopeCss(css: string, scopeClass: string): string {
  const safeScopeClass = sanitizeCssIdentifier(scopeClass);
  if (!css || !safeScopeClass) return "";

  const ast = parseStylesheet(css);
  if (!ast) return "";

  removeUnsupportedAtRules(ast);
  const keyframeNames = namespaceKeyframes(ast, safeScopeClass);
  rewriteAnimationNames(ast, keyframeNames);
  scopeRuleSelectors(ast, `.${safeScopeClass}`);

  return cssTree.generate(ast);
}

function parseStylesheet(css: string): StyleSheet | null {
  try {
    return cssTree.parse(css, {
      context: "stylesheet",
      positions: false,
      parseAtrulePrelude: true,
      parseRulePrelude: true,
      parseValue: true,
      parseCustomProperty: false,
    }) as StyleSheet;
  } catch {
    return null;
  }
}

function removeUnsupportedAtRules(ast: StyleSheet): void {
  const enter: EnterOrLeaveFn = (node, item, list) => {
    if (node.type !== "Atrule") return;
    const name = normalizeCssIdentifier(node.name);
    if (!ALLOWED_BLOCK_AT_RULES.has(name) || node.block === null) {
      list.remove(item);
    }
  };

  cssTree.walk(ast, {
    enter,
  });
}

function namespaceKeyframes(
  ast: StyleSheet,
  scopeClass: string,
): Map<string, string> {
  const keyframeNames = new Map<string, string>();

  cssTree.walk(ast, {
    visit: "Atrule",
    enter(node) {
      if (!isKeyframesAtRule(node)) return;

      const nameNode = getKeyframesNameNode(node);
      if (!nameNode) return;

      const originalName =
        nameNode.type === "Identifier" ? nameNode.name : nameNode.value;
      const scopedName = sanitizeCssIdentifier(`${scopeClass}-${originalName}`);
      if (!scopedName) return;

      keyframeNames.set(originalName, scopedName);
      if (nameNode.type === "Identifier") {
        nameNode.name = scopedName;
      } else {
        nameNode.value = scopedName;
      }
    },
  });

  return keyframeNames;
}

function rewriteAnimationNames(
  ast: StyleSheet,
  keyframeNames: Map<string, string>,
): void {
  if (keyframeNames.size === 0) return;

  cssTree.walk(ast, {
    visit: "Declaration",
    enter(node) {
      const property = normalizeCssIdentifier(node.property);
      if (property !== "animation" && property !== "animation-name") return;

      const rewriteValueNode: EnterOrLeaveFn = (valueNode) => {
        if (valueNode.type === "Identifier") {
          const replacement = keyframeNames.get(valueNode.name);
          if (replacement) valueNode.name = replacement;
        }

        if (valueNode.type === "String") {
          const replacement = keyframeNames.get(valueNode.value);
          if (replacement) valueNode.value = replacement;
        }
      };

      cssTree.walk(node.value, {
        enter: rewriteValueNode,
      });
    },
  });
}

function scopeRuleSelectors(ast: StyleSheet, scope: string): void {
  const enter = function (this: WalkContext, node: Rule) {
    if (isKeyframesAtRule(this.atrule)) return;

    const selector = cssTree.generate(node.prelude);
    const scopedSelector = prefixSelectors(selector, scope);
    const parsed = parseSelectorList(scopedSelector);
    if (parsed) node.prelude = parsed;
  };

  cssTree.walk(ast, {
    visit: "Rule",
    enter,
  });
}

function parseSelectorList(selector: string): SelectorList | null {
  try {
    return cssTree.parse(selector, {
      context: "selectorList",
      positions: false,
      parseRulePrelude: true,
    }) as SelectorList;
  } catch {
    return null;
  }
}

function getKeyframesNameNode(node: Atrule): Identifier | StringNode | null {
  const firstChild = node.prelude?.type === "AtrulePrelude"
    ? node.prelude.children.first
    : null;
  if (firstChild?.type === "Identifier" || firstChild?.type === "String") {
    return firstChild;
  }
  return null;
}

function isKeyframesAtRule(node: Atrule | null): boolean {
  return node ? KEYFRAMES_AT_RULES.has(normalizeCssIdentifier(node.name)) : false;
}

/**
 * Split a selector list on commas, but not commas inside functional
 * pseudo-selectors, attribute selectors, or strings.
 */
function splitSelectors(selectorText: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  parts.push(current);
  return parts;
}

function prefixSelectors(selectorText: string, scope: string): string {
  return splitSelectors(selectorText)
    .map((sel) => prefixSelector(sel.trim(), scope))
    .join(", ");
}

function prefixSelector(selector: string, scope: string): string {
  if (!selector) return selector;

  if (selector === "body" || selector === "html" || selector === "*" || selector === ":root") {
    return scope;
  }

  const widgetRootSelector = prefixWidgetRootSelector(selector, scope);
  if (widgetRootSelector) return widgetRootSelector;

  const rootMatch = selector.match(/^(body|html|:root)([^\s>+~]*)?(?:\s+|[>+~]\s*)?(.*)$/i);
  if (rootMatch) {
    const root = rootMatch[1]!;
    const qualifier = rootMatch[2] ?? "";
    const tail = rootMatch[3]?.replace(/^[>+~]\s*/, "").trim() ?? "";

    if (!qualifier && !tail) return scope;
    if (!tail) return `${root}${qualifier} ${scope}`;
    return `${root}${qualifier} ${scope} ${tail}`;
  }

  return `${scope} ${selector}`;
}

function prefixWidgetRootSelector(selector: string, scope: string): string | null {
  const rootMatch = selector.match(/^(\.widget-container|\[data-scalius-widget-root(?:=(?:"true"|'true'|true))?\])(?=$|[\s>+~.#:[\]])([\s\S]*)$/i);
  if (!rootMatch) return null;

  const rawTail = rootMatch[2] ?? "";
  const tail = rawTail.trimStart();
  if (!tail) return scope;

  if (rawTail.length !== tail.length) {
    return `${scope} ${tail}`;
  }

  if (/^[.#:[\]]/.test(tail)) {
    return `${scope}${tail}`;
  }

  return `${scope} ${tail}`;
}

function sanitizeCssIdentifier(value: string): string {
  const normalized = normalizeCssIdentifier(value)
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) return "";
  return /^[a-z_-]/i.test(normalized) ? normalized : `x-${normalized}`;
}

function normalizeCssIdentifier(value: string): string {
  return decodeCssEscapes(value)
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_match, escape: string) => {
    const hex = escape.trim();
    if (/^[0-9a-fA-F]+$/.test(hex)) {
      const codePoint = Number.parseInt(hex, 16);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return "";
    }
    return escape;
  });
}
