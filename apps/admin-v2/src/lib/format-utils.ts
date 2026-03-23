/**
 * Strip HTML tags and return plain text, truncated to maxLength.
 */
export function getPlainText(html: string | null, maxLength = 60): string {
  if (!html) return "";
  let text = html;
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  text = text.replace(/&nbsp;/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}
