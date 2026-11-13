// Clipboard HTML from word processors says bold, italic and underline with
// inline styles the sanitizer does not keep (`style` declarations it allows
// are layout only): Google Docs wraps a whole paste in
// `<b style="font-weight:normal">` and marks text with
// `<span style="font-weight:700">`, Word writes `font-weight:bold` and
// `font-style:italic` spans. Before the rich-text editor sanitizes a paste,
// this turns those styles into the marks the editor keeps (`strong`, `em`,
// `u`) and unwraps a bold element whose style says it is not bold. It only
// rewrites what it reads into plain HTML; `sanitizeHtml` still decides what
// stays, so nothing here needs to be safe on its own.
import { parseDocument } from "htmlparser2";
import { isTag, isText, type ChildNode } from "domhandler";
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

/** Clipboard HTML with style-only bold, italic and underline written as elements. */
export function pastedHtmlWithMarks(html: string): string {
  const document = parseDocument(untrustedHtml(html), UNTRUSTED_HTML_PARSING);
  let out = "";
  const write = (nodes: readonly ChildNode[], depth: number) => {
    for (const node of nodes) {
      if (isText(node)) {
        out += escapeHtmlText(node.data);
        continue;
      }
      if (!isTag(node) || depth > MAX_DEPTH) continue;
      const name = node.name;
      // Scripts, styles and the like say nothing a paste keeps.
      if (RAW_TEXT_ELEMENTS.has(name) || name === "head" || name === "meta" || name === "link") continue;
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
  return out;
}
