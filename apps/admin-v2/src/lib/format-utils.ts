import { htmlToPlainText } from "@scalius/shared/html-sanitize";

/** Rich text as readable plain text (tags dropped, entities decoded), truncated to maxLength. */
export function getPlainText(html: string | null, maxLength = 60): string {
  const text = htmlToPlainText(html);
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}
