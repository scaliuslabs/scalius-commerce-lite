import { hasRenderableHtmlContent } from "@scalius/shared/html-sanitize";

/**
 * Rich text with nothing in it is one value everywhere. The editor writes
 * `<p></p>` for an emptied field and `<p></p><p></p>` after an Enter; a new
 * resource has `null` or `""`. All of them mean "no text": a form never
 * validates, saves or compares them as different values.
 *
 * Content past this length always has text in it (it would take hundreds of
 * empty paragraphs), so the keystroke path never parses it.
 */
const SURELY_HAS_TEXT = 2000;

export function isEmptyRichText(html: string | null | undefined): boolean {
  if (!html) return true;
  if (html.length > SURELY_HAS_TEXT) return false;
  return !hasRenderableHtmlContent(html);
}

/** The editor's value: `""` for an empty field, the HTML as written otherwise. */
export function richTextOrEmpty(html: string | null | undefined): string {
  return isEmptyRichText(html) ? "" : (html as string);
}

/** A nullable form field's value: `null` for an empty field, the HTML as written otherwise. */
export function richTextOrNull(html: string | null | undefined): string | null {
  return isEmptyRichText(html) ? null : (html as string);
}
