// Switching the store's theme (a built-in template or an app's) without
// losing the merchant's work. The server applies a switch (it keeps the draft
// it replaces as a restore point and the theme it leaves as that theme's
// remembered design); the template library shows the same plan before the
// merchant confirms. Contract: ../storefront-theme.md, "Switching themes".
import { applyStorefrontAppTemplateCarry, type StorefrontAppTemplateTheme } from "./app-templates";
import {
  storefrontThemeTemplateKey,
  storefrontThemeWithContentCarry,
  storefrontThemeWithDesign,
  type StorefrontHomeCarry,
} from "./content";
import type { StorefrontTemplateId, StorefrontThemeDocument } from "./document";
import type { StorefrontSection } from "./sections";
import { storefrontTemplateTheme } from "./templates";

/** The template a switch goes to: a built-in one, or an app's (its theme read against this store). */
export type StorefrontTemplateChoice =
  | { kind: "core"; key: StorefrontTemplateId }
  | { kind: "app"; key: string; theme: StorefrontAppTemplateTheme };

/** What a switch does to the homepage, by section id. */
export interface StorefrontTemplateSwitchPlan {
  /** The template the store leaves and the one it goes to. */
  from: string;
  to: string;
  /** The design the store last had on `to` comes back, whole. */
  restored: boolean;
  /** The merchant's sections whose content a section of the new homepage takes. */
  moved: StorefrontHomeCarry["moved"];
  /** The merchant's sections kept on the new homepage, hidden (ids there). */
  kept: string[];
  /** The merchant's sections that leave the homepage and stay with `from` (ids on the current homepage). */
  left: string[];
}

/** The plan of a switch that brings back `to`'s remembered design: the current homepage stays with the theme it is on. */
export function storefrontRestoredTemplatePlan(current: StorefrontThemeDocument, to: string): StorefrontTemplateSwitchPlan {
  return { from: storefrontThemeTemplateKey(current), to, restored: true, moved: [], kept: [], left: current.pages.home.map((section) => section.id) };
}

/**
 * The draft a switch to `choice` makes from `current`, and its plan. With a
 * remembered design for the chosen template (`remembered`, what the store
 * had there when it last left it), that design comes back with the store's
 * content now (`storefrontThemeWithDesign`). Otherwise the template's look and
 * homepage take the merchant's content by type (`carryStorefrontHome`), one
 * mapping for built-in and app templates. Choosing the template the store is
 * on restyles it: no remembered design, and no section is hidden.
 * `fromHome` is the homepage the current template started with, when it is
 * an app's (a built-in one's is known).
 */
export function switchStorefrontTemplate(
  current: StorefrontThemeDocument,
  choice: StorefrontTemplateChoice,
  options: { remembered?: StorefrontThemeDocument | null; fromHome?: readonly StorefrontSection[] | null } = {},
): { theme: StorefrontThemeDocument; plan: StorefrontTemplateSwitchPlan } {
  const from = storefrontThemeTemplateKey(current);
  if (options.remembered && from !== choice.key) {
    return { theme: storefrontThemeWithDesign(options.remembered, current), plan: storefrontRestoredTemplatePlan(current, choice.key) };
  }
  const result = choice.kind === "core"
    ? storefrontThemeWithContentCarry(storefrontTemplateTheme(choice.key), current, options.fromHome)
    : applyStorefrontAppTemplateCarry(current, choice.key, choice.theme, options.fromHome);
  const carry = result.carry ?? { moved: [], kept: [], left: [] };
  return {
    theme: result.theme,
    plan: { from, to: choice.key, restored: false, moved: carry.moved, kept: carry.kept, left: carry.left },
  };
}
