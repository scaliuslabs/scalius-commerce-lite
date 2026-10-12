// The JSX runtime of storefront components (`jsxImportSource:
// "@scalius/plugin-sdk/storefront"`). JSX builds HTML strings directly: no
// virtual DOM, no hooks, no client code. Text and attribute values are
// escaped; event handlers are refused (client behaviour lives in islands).
//
//   /** @jsxImportSource @scalius/plugin-sdk/storefront */
//   export const Hero = ({ settings }) => <section class="hero"><h2>{settings.heading}</h2></section>;

import { escapeHtml, isHtml, raw, renderChild, type Html, type Renderable } from "./html";

export type { Html, Renderable };

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTRIBUTE_NAME = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;
/** React spellings components may use; the HTML name is written. */
const ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
  tabIndex: "tabindex",
  readOnly: "readonly",
  autoComplete: "autocomplete",
  autoFocus: "autofocus",
  maxLength: "maxlength",
  minLength: "minlength",
  srcSet: "srcset",
  crossOrigin: "crossorigin",
  fetchPriority: "fetchpriority",
  referrerPolicy: "referrerpolicy",
  enterKeyHint: "enterkeyhint",
  inputMode: "inputmode",
  colSpan: "colspan",
  rowSpan: "rowspan",
  dateTime: "datetime",
};

/** A component: props in, markup out. */
export type Component<Props = Record<string, unknown>> = (props: Props & { children?: Renderable }) => Renderable;

type Props = Record<string, unknown> & { children?: unknown };

function kebab(name: string): string {
  return name.startsWith("--") ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function styleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const parts: string[] = [];
  for (const [property, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || entry === undefined || entry === false || entry === "") continue;
    if (!/^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/.test(property)) throw new TypeError(`Invalid style property ${property}.`);
    parts.push(`${kebab(property)}:${String(entry)}`);
  }
  return parts.join(";");
}

function writeAttributes(props: Props, out: string[]): void {
  for (const key in props) {
    if (key === "children" || key === "dangerouslySetInnerHTML" || key === "key") continue;
    const value = props[key];
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") {
      throw new TypeError(`${key}: storefront components render HTML; put client behaviour in an island.`);
    }
    const name = ATTRIBUTE_ALIASES[key] ?? key;
    if (!ATTRIBUTE_NAME.test(name)) throw new TypeError(`Invalid attribute name ${name}.`);
    if (value === true) {
      out.push(" ", name);
      continue;
    }
    const text = name === "style" ? styleText(value) : Array.isArray(value) && name === "class" ? value.filter(Boolean).join(" ") : String(value);
    out.push(" ", name, '="', escapeHtml(text), '"');
  }
}

function element(type: string, props: Props): Html {
  if (!TAG_NAME.test(type)) throw new TypeError(`Invalid element name ${type}.`);
  const tag = type.toLowerCase();
  const out: string[] = ["<", type];
  writeAttributes(props, out);
  out.push(">");
  if (VOID_ELEMENTS.has(tag)) return raw(out.join(""));
  const inner = props.dangerouslySetInnerHTML as { __html?: unknown } | undefined;
  if (inner !== undefined) {
    if (typeof inner?.__html !== "string") throw new TypeError("dangerouslySetInnerHTML takes { __html: string }.");
    out.push(inner.__html);
  } else if (tag === "script" || tag === "style") {
    // Raw text elements: their children are code, never escaped text. Only
    // `Html` (trusted markup) is accepted, so a setting cannot become code.
    const children = props.children;
    if (children !== undefined && children !== null) {
      if (!isHtml(children)) throw new TypeError(`<${tag}> children must be raw(); pass styles in the stylesheet and code in islands.`);
      out.push(children.value);
    }
  } else {
    renderChild(props.children, out);
  }
  out.push("</", type, ">");
  return raw(out.join(""));
}

export function jsx(type: string | ((props: Props) => Renderable), props: Props, _key?: unknown): Html {
  if (typeof type === "function") {
    const result = type(props);
    if (isHtml(result)) return result;
    const out: string[] = [];
    renderChild(result, out);
    return raw(out.join(""));
  }
  return element(type, props);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment(props: { children?: unknown }): Html {
  const out: string[] = [];
  renderChild(props.children, out);
  return raw(out.join(""));
}

type AttributeValue = string | number | boolean | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JSX {
  export type Element = Html;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface HtmlAttributes {
    children?: Renderable;
    class?: AttributeValue | AttributeValue[];
    className?: AttributeValue | AttributeValue[];
    style?: string | Record<string, string | number | null | undefined | false>;
    dangerouslySetInnerHTML?: { __html: string };
    [attribute: string]: unknown;
  }
  export type IntrinsicElements = Record<string, HtmlAttributes>;
}
