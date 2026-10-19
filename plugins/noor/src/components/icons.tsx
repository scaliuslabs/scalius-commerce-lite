// Noor's icons: one stroke family (24px grid, 1.6 stroke, round joins) drawn
// inline, so an icon costs no request and takes the text colour.

import { raw, type Html } from "@scalius/plugin-sdk/storefront";

const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bag: '<path d="M5 8h14l-1 13H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  badge: '<path d="m12 3 2.4 2 3.1-.2.8 3 2.6 1.8-1.2 2.9 1.2 2.9-2.6 1.8-.8 3-3.1-.2L12 21l-2.4-2-3.1.2-.8-3L3.1 14.4l1.2-2.9-1.2-2.9 2.6-1.8.8-3 3.1.2L12 3z"/><path d="m9 12 2 2 4-4"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20z"/><path d="M9 9c0 3 3 6 6 6l1-1.5-2-1-1 .8c-1-.5-1.8-1.3-2.3-2.3l.8-1-1-2L9 9z"/>',
  truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  returns: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
  gift: '<path d="M4 11h16v10H4zM3 7h18v4H3zM12 7v14"/><path d="M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19 14 10"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  pin: '<path d="M12 21s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  play: '<path d="M8 5v14l11-7L8 5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Icons that point along the line of text: they mirror on a right-to-left page (storefront.css). */
const DIRECTIONAL = new Set<IconName>(["chevron", "arrow", "back"]);

export function Icon({ name, size = 20, label }: { name: IconName; size?: number; label?: string }): Html {
  const a11y = label ? `role="img" aria-label="${label.replace(/[<>&"]/g, "")}"` : 'aria-hidden="true" focusable="false"';
  return raw(`<svg class="noor-icon${DIRECTIONAL.has(name) ? " is-dir" : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${PATHS[name]}</svg>`);
}

const SOCIAL: Record<string, string> = {
  facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>',
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 5 3-5 3V9z"/>',
  tiktok: '<path d="M14 3v11a4 4 0 1 1-4-4"/><path d="M14 3c.5 3 2.5 5 5 5"/>',
  whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20z"/><path d="M9 9c0 3 3 6 6 6l1-1.5-2-1-1 .8c-1-.5-1.8-1.3-2.3-2.3l.8-1-1-2L9 9z"/>',
  twitter: '<path d="M4 4l16 16M20 4 4 20"/>',
  x: '<path d="M4 4l16 16M20 4 4 20"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/>',
  pinterest: '<circle cx="12" cy="12" r="9"/><path d="M11 8c3-1 5 1 4 4s-3 3-4 1M11 9l-2 10"/>',
  telegram: '<path d="m3 11 18-7-3 16-6-5-3 3v-5l9-7"/>',
};

/** A social network's icon; a generic link icon for others. */
export function SocialIcon({ network, label }: { network: string; label: string }): Html {
  const path = SOCIAL[network] ?? '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
  return raw(`<svg class="noor-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label.replace(/[<>&"]/g, "")}">${path}</svg>`);
}
