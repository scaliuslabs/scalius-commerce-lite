// Clipboard HTML from word processors says bold, italic and underline with
// inline styles the sanitizer does not keep (`style` declarations it allows
// are layout only): Google Docs wraps a whole paste in
// `<b style="font-weight:normal">` and marks text with
// `<span style="font-weight:700">`, Word writes `font-weight:bold` and
// `font-style:italic` spans. Word also writes a list as paragraphs
// (`<p class=MsoListParagraph style="mso-list:l0 level1 lfo1">`) that each
// start with their own bullet or number in a `mso-list:Ignore` span. Before
// the rich-text editor sanitizes a paste, this turns those styles into the
// marks the editor keeps (`strong`, `em`, `u`), unwraps a bold element whose
// style says it is not bold, writes Word's list paragraphs as real lists, and
// leaves out the images the caller does not keep (another site's address: a
// pasted Google Docs image is a link to Google's server). It only rewrites
// what it reads into plain HTML; `sanitizeHtml` still decides what stays, so
// nothing here needs to be safe on its own.
import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { RAW_TEXT_ELEMENTS, UNTRUSTED_HTML_PARSING, VOID_ELEMENTS, escapeHtmlText, untrustedHtml, writeStartTag } from "./html-writer";

interface Marks {
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
}

const MAX_DEPTH = 64;

/** What an element's inline style says about weight, slant and underline (null: it says nothing). */
function styleMarks(style: string | undefined): Marks {
  const marks: Marks = { bold: null, italic: null, underline: null };
  if (!style) return marks;
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
    if (property === "font-weight") {
      const weight = Number(value);
      marks.bold = value === "bold" || value === "bolder" || (Number.isFinite(weight) && weight >= 600)
        ? true
        : value === "normal" || value === "lighter" || (Number.isFinite(weight) && weight < 600) ? false : null;
    } else if (property === "font-style") {
      marks.italic = value === "italic" || value === "oblique" ? true : value === "normal" ? false : null;
    } else if (property === "text-decoration" || property === "text-decoration-line") {
      marks.underline = /\bunderline\b/.test(value) ? true : /\bnone\b/.test(value) ? false : null;
    }
  }
  return marks;
}

const BOLD_TAGS = new Set(["b", "strong"]);
const ITALIC_TAGS = new Set(["i", "em"]);

/** Word's list paragraph style: `mso-list:l0 level2 lfo1` (list 0, level 2). */
const MSO_LIST = /mso-list:\s*l\d+\s+level(\d+)/i;
const MSO_LIST_IGNORE = /mso-list:\s*ignore/i;
/** A numbered marker: `1.`, `a)`, `iv.`. Anything else (`·`, `o`, `§`, `•`) is a bullet. */
const ORDERED_MARKER = /^(?:\d{1,4}|[a-z]{1,3})[.)]$/i;

/** The element holding Word's bullet or number for its list paragraph, if any. */
function wordListMarker(node: Element, depth = 0): Element | null {
  if (depth > 6) return null;
  for (const child of node.children) {
    if (!isTag(child)) continue;
    if (MSO_LIST_IGNORE.test(child.attribs.style ?? "")) return child;
    const found = wordListMarker(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function textOf(node: ChildNode, depth = 0): string {
  if (isText(node)) return node.data;
  if (!isTag(node) || depth > 6) return "";
  return node.children.map((child) => textOf(child, depth + 1)).join("");
}

interface WordListItem {
  node: Element;
  marker: Element;
  level: number;
  tag: "ul" | "ol";
}

/** A Word list paragraph as a list item: its level and kind, from its style and marker. */
function wordListItem(node: ChildNode): WordListItem | null {
  if (!isTag(node) || node.name !== "p") return null;
  const style = node.attribs.style ?? "";
  const listed = MSO_LIST.exec(style);
  if (!listed && !/^MsoListParagraph/i.test(node.attribs.class ?? "")) return null;
  const marker = wordListMarker(node);
  if (!marker) return null;
  const label = textOf(marker).replace(/[\s\u00a0]+/g, "");
  return { node, marker, level: Math.min(Number(listed?.[1] ?? 1) || 1, 9), tag: ORDERED_MARKER.test(label) ? "ol" : "ul" };
}

/** Text or a node Word puts between list paragraphs that says nothing (white space, comments). */
function isBetweenItems(node: ChildNode): boolean {
  if (isText(node)) return !node.data.trim();
  return !isTag(node);
}

export interface PastedHtmlOptions {
  /** Whether an image at this address stays (default: every one). */
  keepImage?: (src: string) => boolean;
}

export interface PastedHtml {
  html: string;
  /** Images left out because `keepImage` refused their address. */
  droppedImages: number;
}

/**
 * Clipboard HTML with style-only bold, italic and underline written as
 * elements, Word's list paragraphs written as lists, and only the images the
 * caller keeps.
 */
export function pastedHtml(html: string, options: PastedHtmlOptions = {}): PastedHtml {
  const document = parseDocument(untrustedHtml(html), UNTRUSTED_HTML_PARSING);
  let out = "";
  let droppedImages = 0;
  const skip = new Set<Element>();
  const writeList = (items: readonly WordListItem[], depth: number) => {
    const open: Array<{ level: number; tag: "ul" | "ol" }> = [];
    for (const item of items) {
      while (open.length > 0 && open.at(-1)!.level > item.level) out += `</li></${open.pop()!.tag}>`;
      const top = open.at(-1);
      if (top && top.level === item.level && top.tag !== item.tag) {
        out += `</li></${open.pop()!.tag}>`;
      }
      const current = open.at(-1);
      if (current && current.level === item.level) out += "</li>";
      else {
        out += `<${item.tag}>`;
        open.push({ level: item.level, tag: item.tag });
      }
      out += "<li>";
      skip.add(item.marker);
      write(item.node.children, depth + 1);
    }
    while (open.length > 0) out += `</li></${open.pop()!.tag}>`;
  };
  const write = (nodes: readonly ChildNode[], depth: number) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (isText(node)) {
        out += escapeHtmlText(node.data);
        continue;
      }
      if (!isTag(node) || depth > MAX_DEPTH || skip.has(node)) continue;
      const first = wordListItem(node);
      if (first) {
        // The run of list paragraphs that follow one another is one list.
        const items = [first];
        let next = index + 1;
        let end = index;
        while (next < nodes.length) {
          const candidate = nodes[next]!;
          const item = wordListItem(candidate);
          if (item) {
            items.push(item);
            end = next;
          } else if (!isBetweenItems(candidate)) break;
          next += 1;
        }
        writeList(items, depth);
        index = end;
        continue;
      }
      const name = node.name;
      // Scripts, styles and the like say nothing a paste keeps.
      if (RAW_TEXT_ELEMENTS.has(name) || name === "head" || name === "meta" || name === "link") continue;
      if (name === "img" && options.keepImage && !options.keepImage(node.attribs.src?.trim() ?? "")) {
        droppedImages += 1;
        continue;
      }
      const marks = styleMarks(node.attribs.style);
      // Google Docs' wrapper: a bold element whose style says it is not bold carries no mark.
      const unwrap = (BOLD_TAGS.has(name) && marks.bold === false) || (ITALIC_TAGS.has(name) && marks.italic === false);
      const added: string[] = [];
      if (marks.bold === true && !BOLD_TAGS.has(name)) added.push("strong");
      if (marks.italic === true && !ITALIC_TAGS.has(name)) added.push("em");
      if (marks.underline === true && name !== "u") added.push("u");
      if (!unwrap) {
        out += writeStartTag(name, Object.entries(node.attribs));
        if (VOID_ELEMENTS.has(name)) continue;
      }
      for (const mark of added) out += `<${mark}>`;
      write(node.children, depth + 1);
      for (const mark of [...added].reverse()) out += `</${mark}>`;
      if (!unwrap) out += `</${name}>`;
    }
  };
  write(document.children, 0);
  return { html: out, droppedImages };
}
