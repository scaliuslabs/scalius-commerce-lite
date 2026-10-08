/**
 * Built-in glyphs for the social links a store adds without an uploaded
 * icon, chosen by the link's host (the profile URL) and then its label.
 * Facebook is the main channel in Bangladesh, so a store never shows a grey
 * circle with an "F". Unknown hosts keep the first letter of their label.
 * Paths draw in a 24 x 24 box with a 1.6 stroke (the header's icon set).
 */
const GLYPHS = {
  facebook: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />',
  instagram:
    '<rect width="20" height="20" x="2" y="2" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><path d="M17.5 6.5h.01" />',
  youtube:
    '<path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" /><path d="m10 15 5-3-5-3z" />',
  tiktok: '<path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />',
  whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" /><path d="M9 10c.4 2.4 2.6 4.6 5 5" />',
  x: '<path d="M4 4l16 16M20 4 4 20" />',
  linkedin:
    '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" /><rect width="4" height="12" x="2" y="9" /><circle cx="4" cy="4" r="2" />',
} as const;

export type SocialGlyph = keyof typeof GLYPHS;

const HOSTS: Array<[RegExp, SocialGlyph]> = [
  [/(^|\.)(facebook|fb)\.(com|me)$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, "whatsapp"],
  [/(^|\.)(x\.com|twitter\.com)$/, "x"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
];

/** The glyph for a social link: its host first, its label as a fallback; null when neither is a known network. */
export function socialGlyph(url: string, label: string | null | undefined): SocialGlyph | null {
  let host = "";
  try {
    host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const byHost = HOSTS.find(([pattern]) => pattern.test(host));
  if (byHost) return byHost[1];
  const name = (label ?? "").trim().toLowerCase();
  const byName = (Object.keys(GLYPHS) as SocialGlyph[]).find((glyph) => name === glyph);
  return byName ?? null;
}

/** The glyph's SVG children (trusted constants, safe for `set:html`). */
export function socialGlyphMarkup(glyph: SocialGlyph): string {
  return GLYPHS[glyph];
}
