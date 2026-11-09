// An app's template as the template library offers it: declared by an
// active app whose approved grant covers storefront code, its catalogue
// handles resolved against this store and the card fields the store cannot
// show left out. The dashboard's template switch and the app API's
// `theme.apply_template` read it here, so both apply exactly the same theme.
import {
  STOREFRONT_DECLARATION_THEME_VERSION,
  resolveStorefrontAppTemplateTheme,
  storefrontAppTemplateCardFields,
  withStorefrontCardFields,
  type StorefrontAppTemplateTheme,
  type StorefrontAppThemeResolvedRead,
} from "@scalius/shared/storefront-theme";
import type { Database } from "@scalius/database/client";
import { readStorefrontCardFields } from "@scalius/core/modules/settings";
import { listPluginInstallations } from "@scalius/core/modules/plugins";
import { readThemeHandleLookup } from "@scalius/core/modules/storefront";

type Installations = Awaited<ReturnType<typeof listPluginInstallations>>;

export type OfferedAppTemplate =
  | { ok: true; theme: StorefrontAppTemplateTheme; unresolved: Extract<StorefrontAppThemeResolvedRead<StorefrontAppTemplateTheme>, { ok: true }>["unresolved"] }
  /** `missing`: no active app offers it; `unfit`: it does not fit this store's theme (`problem` says why). */
  | { ok: false; reason: "missing" | "unfit"; problem?: string };

/** `<app id>/<template id>` split, or null for a built-in template's id. */
export function appTemplateKeyParts(key: string): { pluginId: string; templateId: string } | null {
  const separator = key.indexOf("/");
  return separator > 0 ? { pluginId: key.slice(0, separator), templateId: key.slice(separator + 1) } : null;
}

/** The template `key` (`<app id>/<template id>`) as the template library offers it in this store. */
export async function readOfferedAppTemplate(db: Database, key: string, installations?: Installations): Promise<OfferedAppTemplate> {
  const parts = appTemplateKeyParts(key);
  if (!parts) return { ok: false, reason: "missing" };
  const installation = (installations ?? await listPluginInstallations(db)).find((each) => each.pluginId === parts.pluginId);
  // The template library offers an app's templates only while its approved grant covers storefront code.
  const declared = installation?.status === "active" && installation.grant?.storefrontSurfaces === true && installation.grant.storefrontCode === true
    ? installation.manifest.storefront.templates.find((template) => template.id === parts.templateId)
    : undefined;
  if (!declared) return { ok: false, reason: "missing" };
  const [lookup, cardFields] = await Promise.all([
    readThemeHandleLookup(db, [declared.theme]),
    readStorefrontCardFields(db, storefrontAppTemplateCardFields(declared.theme)),
  ]);
  const read = resolveStorefrontAppTemplateTheme(declared.theme, declared.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION, lookup);
  if (!read.ok) return { ok: false, reason: "unfit", problem: read.problem };
  // A card field the store has no storefront-visible product field for is left out.
  const { theme } = withStorefrontCardFields(read.value, (field) => cardFields.has(field));
  return { ok: true, theme, unresolved: read.unresolved };
}

/** The homepage an app template starts with, for telling its untouched sections apart; null when the app no longer offers it. */
export async function offeredAppTemplateHome(db: Database, key: string, installations?: Installations) {
  const read = await readOfferedAppTemplate(db, key, installations);
  return read.ok ? read.theme.sections ?? null : null;
}
