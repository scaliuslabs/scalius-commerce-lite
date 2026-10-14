// Rows for 0153_theme_skins: stored theme documents and app manifests in the
// shape before skins, and the shape each must read as after. Portable SQL: the
// same text seeds SQLite and PostgreSQL.
import { parsePluginManifest, type PluginManifest } from "@scalius/shared/plugins";
import { expect } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontThemeDocumentSchema, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ref = (app: string, values: Record<string, unknown> = {}) => ({ app, values });

type Skins = NonNullable<NonNullable<StorefrontThemeDocument["apps"]>["skins"]>;
const OLD_KEY = { header: "header", footer: "footer", "product-card": "productCard" } as const;

/** A theme document with these skins (and the template label), as it reads now. */
function current(skins: Skins | null): StorefrontThemeDocument {
  const document = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  return skins ? { ...document, apps: { skins, template: "acme.theme/bold" } } : document;
}

/** The same document as it was stored before skins. */
function before(document: StorefrontThemeDocument): string {
  const { apps, ...rest } = document;
  if (!apps) return JSON.stringify(rest);
  const { skins = {}, ...others } = apps;
  const old: Record<string, unknown> = { ...others };
  for (const [unit, value] of Object.entries(skins)) old[OLD_KEY[unit as keyof typeof OLD_KEY]] = value;
  return JSON.stringify({ ...rest, apps: old });
}

const wrapped = (theme: string) => JSON.stringify({ meta: { changes: [], moreChanges: 0, note: null }, theme: JSON.parse(theme) });

export const THEME_EXPECTED = {
  published: current({ header: ref("acme.theme/head", { sticky: true, logo: null }), footer: ref("acme.theme/foot"), "product-card": ref("acme.theme/card", { ratio: "tall" }) }),
  draft: current({ footer: ref("acme.theme/foot", { tagline: "Eid" }) }),
  versionEnvelope: current({ header: ref("acme.theme/head") }),
  versionPlain: current(null),
  versionBare: current({ "product-card": ref("acme.theme/card") }),
  restore: current({ header: ref("acme.theme/head"), "product-card": ref("acme.theme/card") }),
};

function manifest(skins: Array<{ id: string; target: string; name: string }>): PluginManifest {
  const parsed = parsePluginManifest({
    id: "acme.theme", name: "Theme", version: "1.0.0", apiVersion: "2026-10", description: "A theme.", author: { name: "Acme" },
    storefront: { skins: skins.map((skin) => ({ ...skin, settings: [{ key: "sticky", label: "Sticky", type: "boolean", default: true }] })) },
  });
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join(" "));
  return parsed.manifest;
}

/** The manifest as installations stored it before skins: `storefront.slots` with `slot`. */
function storedBefore(value: PluginManifest, id: string): string {
  const { skins, ...storefront } = value.storefront;
  return JSON.stringify({
    ...value,
    id,
    storefront: { ...storefront, slots: skins.map(({ target, ...skin }) => ({ ...skin, slot: target })) },
  });
}

export const MANIFEST_EXPECTED = {
  theme: manifest([{ id: "head", target: "header", name: "Header" }, { id: "card", target: "product-card", name: "Card" }]),
  plain: manifest([]),
};

export function themeSkinsSeed(): string {
  return `
INSERT INTO theme_settings(id,colors,revision) VALUES ('default',${quote(before(THEME_EXPECTED.published))},4);
INSERT INTO theme_settings_drafts(id,theme,revision,base_published_revision) VALUES ('default',${quote(before(THEME_EXPECTED.draft))},9,4);
INSERT INTO theme_settings_versions(id,published_revision,theme,source) VALUES
  ('themev_envelope',4,${quote(wrapped(before(THEME_EXPECTED.versionEnvelope)))},'publish'),
  ('themev_plain',3,${quote(wrapped(before(THEME_EXPECTED.versionPlain)))},'publish'),
  ('themev_bare',2,${quote(before(THEME_EXPECTED.versionBare))},'publish');
INSERT INTO theme_restore_points(id,theme,draft_revision,reason) VALUES ('themerp_skins1',${quote(before(THEME_EXPECTED.restore))},3,'discard');
INSERT INTO plugin_installations(plugin_id,version,source,bundle_sha256,manifest_json,revision) VALUES
  ('acme.theme','1.0.0','upload','${"a".repeat(64)}',${quote(storedBefore(MANIFEST_EXPECTED.theme, "acme.theme"))},3),
  ('acme.plain','1.0.0','upload','${"b".repeat(64)}',${quote(storedBefore(MANIFEST_EXPECTED.plain, "acme.plain"))},1);
`;
}

/** What every migrated row must read as: today's strict schemas accept it, and it is the same look. */
export function expectSkinsRows(rows: {
  published: string;
  draft: string;
  versions: Record<string, string>;
  restore: string;
  manifests: Record<string, string>;
}): void {
  const theme = (value: string) => {
    const parsed = storefrontThemeDocumentSchema.safeParse(JSON.parse(value));
    expect(parsed.error?.issues ?? []).toEqual([]);
    return parsed.data;
  };
  const envelope = (value: string) => theme(JSON.stringify((JSON.parse(value) as { theme: unknown }).theme));
  expect(theme(rows.published)).toEqual(THEME_EXPECTED.published);
  expect(theme(rows.draft)).toEqual(THEME_EXPECTED.draft);
  expect(envelope(rows.versions.themev_envelope!)).toEqual(THEME_EXPECTED.versionEnvelope);
  expect(envelope(rows.versions.themev_plain!)).toEqual(THEME_EXPECTED.versionPlain);
  expect(theme(rows.versions.themev_bare!)).toEqual(THEME_EXPECTED.versionBare);
  expect(theme(rows.restore)).toEqual(THEME_EXPECTED.restore);
  for (const [id, expected] of [["acme.theme", MANIFEST_EXPECTED.theme], ["acme.plain", { ...MANIFEST_EXPECTED.plain, id: "acme.plain" }]] as const) {
    const parsed = parsePluginManifest(JSON.parse(rows.manifests[id]!));
    expect(parsed.ok ? parsed.manifest : parsed.issues).toEqual(expected);
  }
}
