// An app's template as the template library offers it: declared by an
// active app whose approved grant covers storefront code, its catalogue
// handles resolved against this store and the card fields the store cannot
// show left out. The dashboard's template switch and the app API's
// `theme.apply_template` read it here, so both apply exactly the same theme;
// a template update reads its base release the same way
// (`readTemplateUpdateSources`), so the two compare as the store has them.
import {
  resolveStorefrontAppTemplateTheme,
  storefrontAppTemplateCardFields,
  withStorefrontCardFields,
  type StorefrontAppTemplateTheme,
  type StorefrontAppThemeResolvedRead,
} from "@scalius/shared/storefront-theme";
import type { Database } from "@scalius/database/client";
import { readStorefrontCardFields, readThemeTemplateBase, type ThemeTemplateDeclaration, type ThemeTemplateUpdateSources } from "@scalius/core/modules/settings";
import { listPluginInstallations } from "@scalius/core/modules/plugins";
import { readThemeHandleLookup } from "@scalius/core/modules/storefront";

type Installations = Awaited<ReturnType<typeof listPluginInstallations>>;
type Resolved = Extract<StorefrontAppThemeResolvedRead<StorefrontAppTemplateTheme>, { ok: true }>;

export type OfferedAppTemplate =
  | { ok: true; theme: StorefrontAppTemplateTheme; unresolved: Resolved["unresolved"]; declaration: ThemeTemplateDeclaration }
  /** `missing`: no active app offers it; `unfit`: it does not fit this store's theme (`problem` says why). */
  | { ok: false; reason: "missing" | "unfit"; problem?: string };

/** `<app id>/<template id>` split, or null for a built-in template's id. */
export function appTemplateKeyParts(key: string): { pluginId: string; templateId: string } | null {
  const separator = key.indexOf("/");
  return separator > 0 ? { pluginId: key.slice(0, separator), templateId: key.slice(separator + 1) } : null;
}

/** One release's declaration of a template read against this store: handles resolved, card fields it lacks left out. */
async function resolveDeclaration(db: Database, key: string, declaration: ThemeTemplateDeclaration) {
  const parts = appTemplateKeyParts(key)!;
  const [lookup, cardFields] = await Promise.all([
    readThemeHandleLookup(db, [declaration.theme]),
    readStorefrontCardFields(db, storefrontAppTemplateCardFields(declaration.theme)),
  ]);
  const read = resolveStorefrontAppTemplateTheme(declaration.theme, declaration.themeVersion, lookup, parts.pluginId, parts.templateId);
  if (!read.ok) return read;
  // A card field the store has no storefront-visible product field for is left out.
  const { theme } = withStorefrontCardFields(read.value, (field) => cardFields.has(field));
  return { ok: true as const, theme, unresolved: read.unresolved };
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
  if (!installation || !declared) return { ok: false, reason: "missing" };
  const declaration: ThemeTemplateDeclaration = { pluginId: parts.pluginId, appVersion: installation.version, themeVersion: declared.themeVersion, theme: declared.theme };
  const read = await resolveDeclaration(db, key, declaration);
  if (!read.ok) return { ok: false, reason: "unfit", problem: read.problem };
  return { ok: true, theme: read.theme, unresolved: read.unresolved, declaration };
}

/** The homepage an app template starts with, for telling its untouched sections apart; null when the app no longer offers it. */
export async function offeredAppTemplateHome(db: Database, key: string, installations?: Installations) {
  const read = await readOfferedAppTemplate(db, key, installations);
  return read.ok ? read.theme.sections ?? null : null;
}

/** Where a template update stands: the installed release against the base the store keeps. */
export type TemplateUpdateSources =
  | { ok: true; sources: ThemeTemplateUpdateSources; from: string | null; to: string; assumed: boolean }
  /** `missing`: no active app offers the template; `unfit`: the installed release does not fit this store (`problem`); `current`: the store is on that release already. */
  | { ok: false; reason: "missing" | "unfit" | "current"; problem?: string };

/**
 * What a template update for `key` is computed from. The base is the release
 * the store recorded (at the apply, at an update it reviewed, or assumed at
 * the app update that found no record); a store with no record is on the
 * installed release as far as anyone knows, so it has no update, and
 * `compare` instead sets the installed release against the draft with no
 * base (every difference the merchant's choice). A base that no longer reads
 * against this store compares the same way.
 */
export async function readTemplateUpdateSources(db: Database, key: string, options: { compare?: boolean; installations?: Installations } = {}): Promise<TemplateUpdateSources> {
  const theirs = await readOfferedAppTemplate(db, key, options.installations);
  if (!theirs.ok) return theirs;
  const recorded = options.compare ? null : await readThemeTemplateBase(db, key);
  const same = recorded !== null && recorded.themeVersion === theirs.declaration.themeVersion
    && JSON.stringify(recorded.theme) === JSON.stringify(theirs.declaration.theme);
  if (!options.compare && (recorded === null || same)) return { ok: false, reason: "current" };
  const base = recorded ? await resolveDeclaration(db, key, recorded) : null;
  return {
    ok: true,
    sources: {
      key,
      base: base?.ok ? base.theme : null,
      theirs: theirs.theme,
      unresolved: theirs.unresolved.flatMap((each) => (each.sectionId ? [each.sectionId] : [])),
      declaration: theirs.declaration,
    },
    from: recorded?.appVersion ?? null,
    to: theirs.declaration.appVersion,
    assumed: recorded?.source === "update",
  };
}
