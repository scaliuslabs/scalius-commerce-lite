// Volt's line icons (24px grid, stroke drawn): the header actions, the trust
// strip, the product page's info rows and the footer's social links.

const PATHS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  cart: "M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2M10 20.5h.01M17 20.5h.01",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  gift: "M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  blog: "M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h6",
  compare: "M7 4v16M17 4v16M3 8l4-4 4 4M13 16l4 4 4-4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  down: "M6 9l6 6 6-6",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  card: "M3 6h18v12H3zM3 10h18M7 15h4",
  truck: "M2 6h12v10H2zM14 9h4l3 3v4h-7M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  swap: "M4 8h13l-3-3M20 16H7l3 3",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  headset: "M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  pin: "M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  chat: "M4 5h16v11H8l-4 4z",
  check: "M5 12l5 5 9-10",
  arrow: "M5 12h14M13 6l6 6-6 6",
  facebook: "M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v7h4v-7h3l1-4h-4V8z",
  instagram: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM17.5 6.5h.01",
  youtube: "M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 9v6l5-3z",
  linkedin: "M4 9h4v11H4zM6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10 9h4v2a4 4 0 0 1 7 3v6h-4v-6a2 2 0 0 0-3-1.5V20h-4z",
  whatsapp: "M4 20l1.3-4A8 8 0 1 1 8 18.7zM9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.5-2-1-1 1a5 5 0 0 1-2.5-2.5l1-1-1-2z",
  twitter: "M4 4l16 16M20 4 4 20",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
} as const;

export type IconName = keyof typeof PATHS;

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(PATHS, value);
}

export function Icon({ name, size = 20, class: className }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg class={className ? `volt-icon ${className}` : "volt-icon"} width={String(size)} height={String(size)} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A social network's icon, by the name the store's footer settings carry. */
export function socialIcon(network: string): IconName {
  const value = network.toLowerCase();
  if (value.includes("facebook")) return "facebook";
  if (value.includes("instagram")) return "instagram";
  if (value.includes("youtube")) return "youtube";
  if (value.includes("linkedin")) return "linkedin";
  if (value.includes("whatsapp")) return "whatsapp";
  if (value === "x" || value.includes("twitter")) return "twitter";
  return "globe";
}

/** The trust strip's icon for a fact, by its words (EMI, delivery, exchange, price, service). */
export function factIcon(title: string): IconName {
  const value = title.toLowerCase();
  if (/emi|instal|card|pay/.test(value)) return "card";
  if (/deliver|ship/.test(value)) return "truck";
  if (/exchange|return|swap/.test(value)) return "swap";
  if (/price|deal|offer|save/.test(value)) return "tag";
  if (/service|support|help/.test(value)) return "headset";
  if (/warrant|genuine|original/.test(value)) return "shield";
  return "check";
}
