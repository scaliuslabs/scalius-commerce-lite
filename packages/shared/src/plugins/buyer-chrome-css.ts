// What a theme's stylesheet may not hold to style its header or footer on a
// buyer's own page (skins with `buyerPages: true`). There the sheet applies
// inside the chrome's shadow root only (apps/storefront PrivateChrome.astro):
// its selectors reach the theme's own markup and the shadow host, never the
// page. Four things would reach further, so a sheet naming one is not used
// there (the store draws its own chrome) and `scalius-plugin pack` refuses it:
// - `:host-context()` matches the host's ancestors: the page's own elements;
// - `@import` loads a sheet this check never read;
// - `@font-face` and `@property` register a font or a custom property, which
//   some browsers keep for the whole document, so a theme could change how
//   the page's own text and colours draw.
// This is a refusal list on the decoded text (comments gone, CSS escapes read
// as the characters they stand for), never a parse of what the sheet means:
// the shadow root, not this check, is the boundary.

/** The words a buyer-page sheet may not hold, as the check reads them. */
export const BUYER_CHROME_CSS_REFUSED = ["host-context", "@import", "@font-face", "@property"] as const;

const HEX = /[0-9a-fA-F]/;
const WHITESPACE = /[ \t\n\r\f]/;

/**
 * The sheet's text as the browser's tokenizer reads it (CSS Syntax §4.3), in
 * lower case: comments gone (but a `/*` inside a string or after a backslash
 * opens none), every escape read as the character it stands for, a string's
 * text kept. One pass from the start, so no comment, string or escape can
 * hide a word from it that the browser would read.
 */
export function decodedCss(css: string): string {
  let out = "";
  let index = 0;
  /** Reads the escape at `index` (its backslash) and returns its character. */
  const escape = (): string => {
    index += 1;
    if (index >= css.length) return "�";
    if (!HEX.test(css[index]!)) {
      const character = String.fromCodePoint(css.codePointAt(index)!);
      index += character.length;
      return character === "\n" || character === "\r" || character === "\f" ? "" : character;
    }
    let hex = "";
    while (hex.length < 6 && index < css.length && HEX.test(css[index]!)) hex += css[index++];
    if (css[index] === "\r" && css[index + 1] === "\n") index += 2;
    else if (index < css.length && WHITESPACE.test(css[index]!)) index += 1;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
  };
  while (index < css.length) {
    const character = css[index]!;
    if (character === "\\") { out += escape(); continue; }
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      out += " ";
      continue;
    }
    if (character === "\"" || character === "'") {
      out += character;
      index += 1;
      while (index < css.length) {
        const inner = css[index]!;
        if (inner === "\\") { out += escape(); continue; }
        if (inner === "\n" || inner === "\r" || inner === "\f") break;
        out += inner;
        index += 1;
        if (inner === character) break;
      }
      continue;
    }
    out += character;
    index += 1;
  }
  return out.toLowerCase();
}

/** Why the sheet cannot style a buyer page's chrome (the first refused word it holds), or null when it can. */
export function buyerChromeCssProblem(css: string): string | null {
  const text = decodedCss(css);
  const found = BUYER_CHROME_CSS_REFUSED.find((word) => text.includes(word));
  return found ? `the stylesheet holds ${found}, which reaches past the chrome's shadow root` : null;
}
