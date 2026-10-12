// Safe HTML strings for storefront components. A component returns `Html`;
// every other value it interpolates is text and is escaped. Only `Html` made
// by this module (markup the JSX runtime built, or `raw()`) passes through
// unescaped, so a component cannot inject markup by accident.

const HTML_BRAND: unique symbol = Symbol.for("scalius.html");

/** Markup that is already safe to place in a page. */
export interface Html {
  readonly [HTML_BRAND]: true;
  readonly value: string;
  toString(): string;
}

class SafeHtml implements Html {
  readonly [HTML_BRAND] = true as const;
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function isHtml(value: unknown): value is Html {
  return typeof value === "object" && value !== null && (value as { [HTML_BRAND]?: unknown })[HTML_BRAND] === true;
}

/**
 * Trusted markup, placed as is. Use it for markup your own code built (an
 * inline SVG icon), never for text from settings or data.
 */
export function raw(markup: string): Html {
  return new SafeHtml(String(markup));
}

export const EMPTY_HTML: Html = raw("");

const TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const TEXT_PATTERN = /[&<>"']/g;
const TEXT_TEST = /[&<>"']/;

/** Text for an element body or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return TEXT_TEST.test(value) ? value.replace(TEXT_PATTERN, (character) => TEXT_ESCAPES[character]!) : value;
}

/** What a component may return or place as a child. */
export type Renderable = Html | string | number | bigint | boolean | null | undefined | readonly Renderable[];

/** Appends a child to `out`: text is escaped, `Html` passes, false/null/undefined/true render nothing. */
export function renderChild(child: unknown, out: string[]): void {
  if (child === null || child === undefined || child === false || child === true) return;
  if (typeof child === "string") {
    out.push(escapeHtml(child));
  } else if (typeof child === "number" || typeof child === "bigint") {
    out.push(String(child));
  } else if (isHtml(child)) {
    out.push(child.value);
  } else if (Array.isArray(child)) {
    for (const item of child) renderChild(item, out);
  } else if (typeof child === "object" && typeof (child as { then?: unknown }).then === "function") {
    throw new TypeError("Storefront components render synchronously: resolve data before rendering, not inside a component.");
  } else {
    throw new TypeError(`A storefront component cannot render a ${typeof child}.`);
  }
}

/** Joins children into one `Html`. */
export function toHtml(children: unknown): Html {
  if (isHtml(children)) return children;
  const out: string[] = [];
  renderChild(children, out);
  return new SafeHtml(out.join(""));
}

/**
 * Tagged template for markup without JSX: interpolations are escaped text
 * unless they are `Html` (or arrays of it).
 *
 *   html`<p class="note">${settings.text}</p>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  const out: string[] = [strings[0]!];
  for (let index = 0; index < values.length; index += 1) {
    renderChild(values[index], out);
    out.push(strings[index + 1]!);
  }
  return new SafeHtml(out.join(""));
}
