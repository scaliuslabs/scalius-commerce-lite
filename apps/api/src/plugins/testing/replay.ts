// A released app or theme bundle (its upload ZIP) through what this build of
// the store runs on it, each step the code a store runs, recorded as plain
// words so tests/replay/bundles.test.ts can hold every release to what it did
// before:
//
// - install: the upload's checks (`readPluginPackageZip`,
//   `verifyUploadedPackage` as a Super Admin accepting an unsigned package or
//   a new developer) and the install itself, on a fresh migrated database;
// - theme: each template upgraded from its `themeVersion` and checked
//   (`checkStorefrontAppTemplateTheme`), applied to the default look and
//   saved (`checkStorefrontThemeSave`), and each page preset upgraded;
// - buyer UI: each declared extension run on the SDK's fixture input for its
//   slot and its answer checked as the host checks it (the SDK harness and
//   the host share `invokePluginDefinition` and `checkPluginFunctionOutput`);
// - render jobs: each skin and component section with the values the
//   applied template gives it, over the SDK's sample fixture store. The test
//   draws them with the storefront's own render host (it joins two apps, so
//   that half lives in the test).

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activePluginStorefrontExtensions, PluginError, type PluginInstallation } from "@scalius/core/modules/plugins";
import { pluginGrantRequest, PLUGIN_EXTENSION_RUN, type PluginManifest } from "@scalius/shared/plugins";
import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import { resolveStorefrontSettings, type StorefrontExtension, type StorefrontRenderContext, type StorefrontRenderJob } from "@scalius/shared/plugins/storefront-components";
import type { StorefrontSectionSkinData, StorefrontSkinTarget } from "@scalius/shared/plugins/storefront-protocol";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import {
  applyStorefrontAppTemplate,
  checkStorefrontAppTemplateTheme,
  checkStorefrontPagePresetSections,
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_DECLARATION_THEME_VERSION,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { checkStorefrontThemeSave, type StorefrontThemeSaveIssue } from "@scalius/shared/storefront-theme/save";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import { fixtureStore } from "@scalius/plugin-sdk/storefront/testing";
import { readPluginPackageZip } from "../package-zip";
import { installRelease, verifyUploadedPackage, type PluginRelease } from "../releases";

/** One step's outcome: `accepted`-style words, or the refusal's lines. */
export type ReplayVerdict = string | string[];

function refusalOf(error: unknown): string[] {
  if (error instanceof PluginError) {
    const details = (error.details ?? {}) as { reason?: unknown; issues?: Array<{ path?: unknown; message?: unknown }> };
    const lines = [`${error.pluginCode}${typeof details.reason === "string" ? ` (${details.reason})` : ""}: ${error.message}`];
    for (const issue of details.issues ?? []) lines.push(`  ${String(issue.path ?? "")}: ${String(issue.message ?? "")}`);
    return lines;
  }
  return [`threw: ${error instanceof Error ? error.message : String(error)}`];
}

function issueLines(issues: readonly StorefrontThemeSaveIssue[]): string[] {
  return issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}${issue.reason ? ` (${issue.reason})` : ""}`);
}

export interface ReplayInstall {
  verdict: ReplayVerdict;
  release: PluginRelease | null;
  installation: PluginInstallation | null;
}

/** The upload's checks and the install, as a store runs them on this ZIP. */
export async function replayInstall(zip: Uint8Array): Promise<ReplayInstall> {
  const { sqlite, db } = createSqliteD1Database();
  try {
    const files = await readPluginPackageZip(zip);
    const { release } = await verifyUploadedPackage(db, files, { allowUnsigned: true, trustDeveloper: true });
    const installation = await installRelease(db, release, { source: "upload", actorUserId: null });
    return { verdict: release.signer ? "accepted (signed)" : "accepted (unsigned)", release, installation };
  } catch (error) {
    return { verdict: refusalOf(error), release: null, installation: null };
  } finally {
    sqlite.close();
  }
}

export interface ReplayTheme {
  templates: Record<string, ReplayVerdict>;
  pagePresets: Record<string, ReplayVerdict>;
  /** The default look with the first template that saved applied (the values the render jobs take), else the default look. */
  applied: StorefrontThemeDocument;
}

/** Each template upgraded, applied to the default look and saved; each page preset upgraded. */
export function replayTheme(manifest: PluginManifest): ReplayTheme {
  const templates: Record<string, ReplayVerdict> = {};
  let applied: StorefrontThemeDocument | null = null;
  for (const template of manifest.storefront.templates) {
    const read = checkStorefrontAppTemplateTheme(template.theme, template.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION, manifest.id, template.id);
    if (!read.ok) {
      templates[template.id] = [`does not fit: ${read.problem}`, ...issueLines(read.issues)];
      continue;
    }
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, `${manifest.id}/${template.id}`, read.value);
    const saved = checkStorefrontThemeSave(document);
    if (!saved.ok) {
      templates[template.id] = [`save refused: ${saved.refusal.message}`, ...issueLines(saved.refusal.issues)];
      continue;
    }
    templates[template.id] = "applied and saved";
    applied ??= saved.theme;
  }
  const pagePresets: Record<string, ReplayVerdict> = {};
  for (const preset of manifest.storefront.pagePresets) {
    const read = checkStorefrontPagePresetSections(preset.sections, preset.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION);
    pagePresets[preset.id] = read.ok ? `fits (${read.value.length} sections)` : [`does not fit: ${read.problem}`, ...issueLines(read.issues)];
  }
  return { templates, pagePresets, applied: applied ?? DEFAULT_STOREFRONT_THEME };
}

/**
 * Each declared buyer UI extension on the SDK's fixture input for its slot,
 * its answer checked as the host checks it. `module` is the bundle's
 * `plugin.js`, imported.
 */
export async function replayBuyerUi(module: unknown, manifest: PluginManifest): Promise<Record<string, ReplayVerdict>> {
  const outcomes: Record<string, ReplayVerdict> = {};
  if (manifest.storefront.extensions.length === 0) return outcomes;
  let harness: ReturnType<typeof createPluginTestHarness>;
  try {
    harness = createPluginTestHarness(module);
  } catch (error) {
    for (const { target } of manifest.storefront.extensions) outcomes[target] = [`not loaded: ${error instanceof Error ? error.message : String(error)}`];
    return outcomes;
  }
  for (const { target } of manifest.storefront.extensions) {
    try {
      const result = await harness.extension(fixtures.storefrontExtensionInput(target));
      if (!result.ok) {
        outcomes[target] = [`refused: ${result.error?.code ?? "error"}: ${result.error?.message ?? ""}`];
        continue;
      }
      const value = result.value as { ui: unknown; lines?: unknown[] } | null;
      const lines = value?.lines?.length ?? 0;
      outcomes[target] = `valid ${PLUGIN_EXTENSION_RUN} answer (${value?.ui ? "a buyer UI document" : "no document"}${lines > 0 ? `, ${lines} line block(s)` : ""})`;
    } catch (error) {
      outcomes[target] = [`threw: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  return outcomes;
}

/** A render job as a page asks the host for it (the host names it). */
type RenderAsk = StorefrontRenderJob extends infer Job ? Job extends unknown ? Omit<Job, "id"> : never : never;

/** One part the storefront would draw, as its render host is asked for it. */
export interface ReplayRenderJob {
  /** `skin <id> (<target>)` or `section <type> #<instance>`. */
  label: string;
  /** The unit `appMarkup` cuts its markup under. */
  unit: StorefrontSkinTarget | "section";
  ask: RenderAsk;
}

export interface ReplayRender {
  /** The app as the layout read lists it once approved (`activePluginStorefrontExtensions`); null when it ships no storefront code. */
  extension: StorefrontExtension | null;
  context: StorefrontRenderContext;
  jobs: ReplayRenderJob[];
}

/**
 * A merchant's filled-in values for a settings schema: every field set
 * (words, the first option, a link, two list items, the newest products, an
 * image), so a part that draws nothing without content is asked to draw.
 * Values the schema refuses fall back to defaults when resolved.
 */
function sampleValues(schema: PluginSettingsSchema): Record<string, unknown> {
  const value = (field: PluginSettingsSchema[number] | Extract<PluginSettingsSchema[number], { type: "list" }>["fields"][number]): unknown => {
    const words = `Sample ${field.label}`;
    switch (field.type) {
      case "text": case "textarea": return words.slice(0, "maxLength" in field && field.maxLength ? field.maxLength : 200);
      case "number": return "default" in field && typeof field.default === "number" ? field.default : "min" in field && typeof field.min === "number" ? field.min : 1;
      case "boolean": return true;
      case "select": return field.default ?? field.options[0]?.value;
      case "multiselect": return field.options.slice(0, 1).map((option) => option.value);
      case "url": return "https://example.com/";
      case "link": return "/";
      case "color": return field.default ?? "#336699";
      case "email": return "store@example.com";
      case "image": return "media_sample";
      case "product": return "prod_sample";
      case "products": return "newest";
      case "list": return [0, 1].map(() => Object.fromEntries(field.fields.map((item) => [item.key, value(item)])));
      default: return undefined;
    }
  };
  return Object.fromEntries(schema.flatMap((field) => {
    const sample = value(field);
    return sample === undefined ? [] : [[field.key, sample]];
  }));
}

/**
 * A core section's projection with content (the SDK's sample store gives a
 * new section's, which has no slides, tiles or categories): each empty list
 * of slides, tiles, categories or collections filled from the sample store's
 * cards. Other projections stay as the SDK gives them.
 */
function sampleSectionSkinData(store: ReturnType<typeof fixtureStore>, target: StorefrontSkinTarget): StorefrontSectionSkinData {
  const data = store.skinData(target) as StorefrontSectionSkinData;
  const cards = store.productCards();
  const image = store.image();
  const tiles = cards.map((card) => ({ id: card.id, title: card.title, url: card.url, image: card.image ?? image, cards: [] }));
  const fill: Record<string, () => unknown[]> = {
    slides: () => cards.slice(0, 2).map((card) => ({
      image: card.image ?? image, focalPoint: { x: 50, y: 50 }, alt: card.title, heading: card.title, text: "Sample text", buttonLabel: "Shop now", link: card.url, product: card,
    })),
    tiles: () => tiles.map((tile) => ({ image: tile.image, alt: tile.title, href: tile.url })),
    categories: () => tiles,
    collections: () => tiles.map((tile) => ({ ...tile, cards })),
  };
  const settings = { ...(data.settings as Record<string, unknown>) };
  for (const [key, entry] of Object.entries(settings)) {
    if (Array.isArray(entry) && entry.length === 0 && fill[key]) settings[key] = fill[key]();
  }
  return { ...data, settings } as StorefrontSectionSkinData;
}

/**
 * What the storefront asks the app to draw, over the SDK's sample fixture
 * store, twice: on the applied template's pages (every declared skin with the
 * values the template gives it, else its defaults; each component section
 * the template's homepage places, with its values, and a declared type it
 * does not place once with its defaults), and with sample content (every
 * skin and component section with every setting filled in, a core section's
 * skin over a projection with content). A template ships empty content for
 * the merchant to fill, so the second pass is the one that asks each part to
 * draw.
 */
export function replayRenderJobs(installation: PluginInstallation, theme: StorefrontThemeDocument): ReplayRender {
  const store = fixtureStore("sample");
  const approved = { ...installation, status: "active" as const, grant: pluginGrantRequest(installation.declaredManifest) };
  const extension = activePluginStorefrontExtensions([approved])[0] ?? null;
  const context = store.context();
  if (!extension) return { extension, context, jobs: [] };
  const own = (key: string | undefined, id: string) => {
    const parsed = key ? parsePluginSurfaceKey(key) : null;
    return parsed?.pluginId === extension.pluginId && parsed.type === id;
  };
  const home = theme.pages.home;
  const jobs: ReplayRenderJob[] = [];
  for (const skin of extension.skins) {
    const unit = theme.apps?.skins?.[skin.target as keyof NonNullable<NonNullable<StorefrontThemeDocument["apps"]>["skins"]>];
    const placed = home.find((section) => (section as { skin?: { app?: string } }).skin && own((section as { skin?: { app?: string } }).skin?.app, skin.id));
    const values = unit && own(unit.app, skin.id) ? unit.values : (placed as { skin?: { values?: unknown } } | undefined)?.skin?.values ?? {};
    const settings = resolveStorefrontSettings(skin.settings, values, { image: () => store.image(), products: () => [] });
    const section = skin.target.startsWith("section:");
    jobs.push({
      label: `skin ${skin.id} (${skin.target})`,
      unit: skin.target,
      ask: {
        kind: "skin", target: skin.target, component: skin.id, settings, data: store.skinData(skin.target),
        ...(section ? { instanceId: placed?.id ?? `replay-${skin.id}` } : {}),
      } as RenderAsk,
    });
  }
  const sectionSettings = (type: string, values: unknown) =>
    resolveStorefrontSettings(extension.sectionSettings[type] ?? [], values, { image: () => store.image(), products: () => store.productCards() });
  const placedTypes = new Set<string>();
  for (const section of home) {
    if (section.type !== "app") continue;
    const settings = section.settings as { app?: string; values?: unknown };
    const parsed = settings.app ? parsePluginSurfaceKey(settings.app) : null;
    if (!parsed || parsed.pluginId !== extension.pluginId || !extension.sections.includes(parsed.type)) continue;
    placedTypes.add(parsed.type);
    jobs.push({
      label: `section ${parsed.type} #${section.id}`,
      unit: "section",
      ask: { kind: "section", type: parsed.type, instanceId: section.id, settings: sectionSettings(parsed.type, settings.values ?? {}) },
    });
  }
  for (const type of extension.sections) {
    if (placedTypes.has(type)) continue;
    jobs.push({
      label: `section ${type} (defaults)`,
      unit: "section",
      ask: { kind: "section", type, instanceId: `replay-${type}`, settings: sectionSettings(type, {}) },
    });
  }
  for (const skin of extension.skins) {
    const section = skin.target.startsWith("section:");
    jobs.push({
      label: `skin ${skin.id} (${skin.target}, sample content)`,
      unit: skin.target,
      ask: {
        kind: "skin", target: skin.target, component: skin.id,
        settings: resolveStorefrontSettings(skin.settings, sampleValues(skin.settings), { image: () => store.image(), products: () => [] }),
        data: section ? sampleSectionSkinData(store, skin.target) : store.skinData(skin.target),
        ...(section ? { instanceId: `replay-sample-${skin.id}` } : {}),
      } as RenderAsk,
    });
  }
  for (const type of extension.sections) {
    jobs.push({
      label: `section ${type} (sample content)`,
      unit: "section",
      ask: { kind: "section", type, instanceId: `replay-sample-${type}`, settings: sectionSettings(type, sampleValues(extension.sectionSettings[type] ?? [])) },
    });
  }
  return { extension, context, jobs };
}
