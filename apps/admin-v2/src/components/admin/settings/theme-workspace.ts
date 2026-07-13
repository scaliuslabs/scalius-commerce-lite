import type { StorefrontThemeSettings } from "@scalius/shared/storefront-theme";

import { normalizeThemeColors } from "./theme-draft";

export const THEME_WORKSPACE_SECTIONS = [
  {
    value: "system",
    label: "Design system",
    description: "Type, shape, spacing, and component treatment",
  },
  {
    value: "colors",
    label: "Colors",
    description: "Palettes, semantic pairs, and contrast",
  },
  {
    value: "review",
    label: "Review & publish",
    description: "Draft changes, coverage, and live route checks",
  },
] as const;

export type ThemeWorkspaceSection =
  (typeof THEME_WORKSPACE_SECTIONS)[number]["value"];

export function normalizeThemeWorkspaceSection(
  value: unknown,
): ThemeWorkspaceSection {
  return THEME_WORKSPACE_SECTIONS.some((section) => section.value === value)
    ? (value as ThemeWorkspaceSection)
    : "system";
}

export interface ThemeDraftChange {
  key: string;
  label: string;
  published: string;
  draft: string;
}

export function describeThemeDraftChanges(
  publishedInput: StorefrontThemeSettings,
  draftInput: StorefrontThemeSettings,
): ThemeDraftChange[] {
  const published = {
    ...publishedInput,
    colors: normalizeThemeColors(publishedInput.colors),
  };
  const draft = {
    ...draftInput,
    colors: normalizeThemeColors(draftInput.colors),
  };
  const changes: ThemeDraftChange[] = [];

  const add = (key: string, label: string, before: string, after: string) => {
    if (before === after) return;
    changes.push({
      key,
      label,
      published: labelize(before),
      draft: labelize(after),
    });
  };

  add("heading", "Heading type", published.typography.heading, draft.typography.heading);
  add("body", "Body type", published.typography.body, draft.typography.body);
  add("scale", "Type scale", published.typography.scale, draft.typography.scale);
  add("width", "Content width", published.containerWidth, draft.containerWidth);
  add("corners", "Corners", published.cornerStyle, draft.cornerStyle);
  add("density", "Density", published.density, draft.density);
  add("buttons", "Buttons", published.components.buttons, draft.components.buttons);
  add("inputs", "Fields", published.components.inputs, draft.components.inputs);
  add("cards", "Product cards", published.components.cards, draft.components.cards);

  const colorKeys = new Set([
    ...Object.keys(published.colors),
    ...Object.keys(draft.colors),
  ]);
  const changedColors = [...colorKeys]
    .filter((key) => published.colors[key] !== draft.colors[key])
    .sort();

  if (changedColors.length > 0) {
    changes.push({
      key: "colors",
      label: "Semantic colors",
      published: `${Object.keys(published.colors).length} overrides`,
      draft: `${changedColors.length} changed · ${Object.keys(draft.colors).length} overrides`,
    });
  }

  return changes;
}

export interface StorefrontReviewLink {
  label: string;
  description: string;
  href: string;
}

export function buildStorefrontReviewLinks(
  storefrontUrl: string | null | undefined,
): StorefrontReviewLink[] {
  const baseUrl = parseStorefrontUrl(storefrontUrl);
  if (!baseUrl) return [];

  return [
    {
      label: "Home",
      description: "Header, hero, product cards, buttons, and footer",
      href: new URL("/", baseUrl).toString(),
    },
    {
      label: "Search",
      description: "Fields, filters, empty states, and listing density",
      href: new URL("/search", baseUrl).toString(),
    },
  ];
}

function parseStorefrontUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function labelize(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
