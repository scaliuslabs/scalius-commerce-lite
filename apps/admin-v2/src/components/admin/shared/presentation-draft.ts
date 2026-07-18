import type { FooterConfig } from "../footer-builder/types";
import type { HeaderConfig } from "../header-builder/types";

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function choose<T>(base: T, local: T, latest: T): T {
  return equal(base, local) ? latest : local;
}

function rebaseLeaves<T extends object>(
  base: T,
  local: T,
  latest: T,
): T {
  return Object.fromEntries(
    (Object.keys(latest) as Array<keyof T>).map((key) => [
      key,
      choose(base[key], local[key], latest[key]),
    ]),
  ) as T;
}

export function rebaseHeaderDraft(
  base: HeaderConfig,
  local: HeaderConfig,
  latest: HeaderConfig,
): HeaderConfig {
  return {
    topBar: rebaseLeaves(base.topBar, local.topBar, latest.topBar),
    logo: rebaseLeaves(base.logo, local.logo, latest.logo),
    favicon: rebaseLeaves(base.favicon, local.favicon, latest.favicon),
    contact: rebaseLeaves(base.contact, local.contact, latest.contact),
    social: choose(base.social, local.social, latest.social),
    navigation: choose(base.navigation, local.navigation, latest.navigation),
  };
}

export function rebaseFooterDraft(
  base: FooterConfig,
  local: FooterConfig,
  latest: FooterConfig,
): FooterConfig {
  return {
    logo: rebaseLeaves(base.logo, local.logo, latest.logo),
    tagline: choose(base.tagline, local.tagline, latest.tagline),
    description: choose(base.description, local.description, latest.description),
    copyrightText: choose(
      base.copyrightText,
      local.copyrightText,
      latest.copyrightText,
    ),
    menus: choose(base.menus, local.menus, latest.menus),
    social: choose(base.social, local.social, latest.social),
  };
}
