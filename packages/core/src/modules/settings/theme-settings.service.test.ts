import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ids from "nanoid";

vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return { ...actual, nanoid: vi.fn(actual.nanoid) };
});

import {
  createThemePreviewSession,
  discardThemeDraft,
  restoreThemeVersion,
  saveThemePageDraft,
  exchangeThemePreviewContinuation,
  getThemeSettings,
  getThemeVersion,
  getThemeWorkspace,
  listThemeVersions,
  publishThemeDraft,
  resolveThemePreviewSession,
  saveThemeDraft,
  THEME_DOCUMENT_MAX_BYTES,
  THEME_VERSION_HISTORY_LIMIT,
} from "./site-settings.service";
import {
  DEFAULT_STOREFRONT_THEME,
  compareThemeDocuments,
  storefrontTemplateTheme,
  storefrontSectionDefault,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";

/** The version 1 shape stores saved before the strict document. */
const V1_THEME = JSON.stringify({
  colors: { primary: "#18181b" },
  typography: { heading: "system", body: "system", scale: "standard" },
  cornerStyle: "subtle",
  density: "comfortable",
  containerWidth: "wide",
  components: { buttons: "solid", inputs: "outlined", cards: "bordered" },
  layout: {
    header: "classic",
    footer: "columns",
    productCard: { imageRatio: "square", hoverImage: false, quickBuy: false, badge: "image" },
    grid: { desktop: 4, mobile: 2 },
    productPage: { gallery: "beside", thumbnails: "below" },
    homepage: ["hero", "collections", "categories", "delivery"],
  },
});

/** A version 3 document (layout choices and fixed homepage blocks, no template or blocks). */
const V3_THEME = JSON.stringify({"version": 3, "mode": "configured", "tokens": {"typography": "retail", "radius": "subtle", "buttonShape": "radius", "containerWidth": "wide", "components": {"buttons": "solid", "inputs": "outlined", "cards": "bordered"}, "colors": {"popover": "#ffffff", "popover-foreground": "#1d1c1a", "ring": "#1d1c1a", "background": "#fbfaf7", "foreground": "#1d1c1a", "card": "#ffffff", "card-foreground": "#1d1c1a", "primary": "#1d1c1a", "primary-foreground": "#fbfaf7", "secondary": "#f1eee8", "secondary-foreground": "#1d1c1a", "muted": "#f1eee8", "muted-foreground": "#5d5850", "accent": "#e9e3d8", "accent-foreground": "#1d1c1a", "destructive": "#b42318", "destructive-foreground": "#ffffff", "border": "#e5e0d6", "input": "#d3ccbf"}}, "layout": {"header": "classic", "footer": "columns", "card": "standard", "density": "compact", "productPage": "gallery", "navigation": "menu", "mobileNavigation": "drawer"}, "sections": [{"id": "hero", "type": "hero", "version": 1, "settings": {}}, {"id": "collections", "type": "collections", "version": 1, "settings": {}}, {"id": "categories", "type": "categories", "version": 1, "settings": {}}, {"id": "delivery", "type": "delivery", "version": 1, "settings": {}}]});
/** A version 4 document (the shape before 0093): the template with the old version. */
const V4_THEME = JSON.stringify({ ...storefrontTemplateTheme("boutique"), version: 4 });

describe("versioned storefront theme settings", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let batchCalls: number;

  beforeEach(() => {
    batchCalls = 0;
    ({ sqlite, db } = createSqliteD1Database({ beforeBatch: () => { batchCalls += 1; } }));
  });

  afterEach(() => sqlite.close());

  function seedPublishedWorkspace({
    theme = DEFAULT_STOREFRONT_THEME,
    publishedRevision = 1,
    draftRevision = 1,
  }: {
    theme?: StorefrontThemeDocument;
    publishedRevision?: number;
    draftRevision?: number;
  } = {}) {
    const serialized = JSON.stringify(theme);
    sqlite.prepare(`
      INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
      VALUES ('default', ?, ?, 1, 1)
    `).run(serialized, publishedRevision);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (
        id, theme, revision, base_published_revision, updated_by, created_at, updated_at
      ) VALUES ('default', ?, ?, ?, NULL, 1, 1)
    `).run(serialized, draftRevision, publishedRevision);
    sqlite.prepare(`
      INSERT INTO theme_settings_versions (
        id, published_revision, theme, source, source_revision, published_by, created_at
      ) VALUES (?, ?, ?, 'migration', NULL, NULL, 1)
    `).run(`themev_seed_${publishedRevision}`, publishedRevision, serialized);
  }

  it("reads unpublished defaults at revision zero", async () => {
    await expect(getThemeSettings(db)).resolves.toEqual({
      theme: DEFAULT_STOREFRONT_THEME,
      revision: 0,
    });
  });

  it("loads the normal published and draft workspace in one provider batch", async () => {
    seedPublishedWorkspace();

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: DEFAULT_STOREFRONT_THEME, revision: 1, basePublishedRevision: 1 },
    });
    expect(batchCalls).toBe(1);
  });

  it("fails closed on invalid authoritative theme documents", async () => {
    const unknownFont = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as {
      tokens: { typography: string };
    };
    unknownFont.tokens.typography = "remote-font";
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME);
    lowContrast.tokens.colors.foreground = "#f5f5f5";

    for (const stored of [JSON.stringify(unknownFont), JSON.stringify(lowContrast), "{not json"]) {
      sqlite.exec("DELETE FROM theme_settings");
      sqlite.prepare(`
        INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
        VALUES ('default', ?, 1, 1, 1)
      `).run(stored);

      await expect(getThemeSettings(db)).rejects.toMatchObject({
        status: 503,
        code: "service_unavailable",
        message: "Published storefront style is unreadable. Re-save it before editing.",
      });
      await expect(getThemeWorkspace(db)).rejects.toMatchObject({ status: 503 });
    }
  });

  it("fails closed when a stored draft or history row is malformed", async () => {
    seedPublishedWorkspace();
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?").run("{broken");
    await expect(getThemeWorkspace(db)).rejects.toMatchObject({ status: 503 });
    await expect(publishThemeDraft(db, 1, 1)).rejects.toMatchObject({ status: 503 });

    sqlite.prepare("UPDATE theme_settings_versions SET theme = ?").run(JSON.stringify({ meta: { changes: [{ kind: "unknown" }], moreChanges: 0, note: null }, theme: DEFAULT_STOREFRONT_THEME }));
    await expect(listThemeVersions(db)).rejects.toMatchObject({ status: 503 });
    sqlite.prepare("UPDATE theme_settings_versions SET theme = ?").run(JSON.stringify({ meta: { changes: [], moreChanges: 0, note: null }, theme: { version: 99 } }));
    await expect(getThemeVersion(db, 1)).rejects.toMatchObject({ status: 503 });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 1 });
  });

  it("rejects invalid writes with the first issue message and stores nothing", async () => {
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME);
    lowContrast.tokens.colors.foreground = "#f5f5f5";
    const pages = (home: unknown[]) => ({ ...DEFAULT_STOREFRONT_THEME, pages: { ...DEFAULT_STOREFRONT_THEME.pages, home } });
    const invalid: Array<{ theme: unknown; message: RegExp }> = [
      {
        theme: lowContrast,
        message: /^foreground on background has contrast .* it needs at least 4\.5:1\.$/,
      },
      { theme: JSON.parse(V1_THEME), message: /./ },
      { theme: { ...DEFAULT_STOREFRONT_THEME, version: 3 }, message: /./ },
      { theme: JSON.parse(V3_THEME), message: /./ },
      { theme: pages([...DEFAULT_STOREFRONT_THEME.pages.home, { id: "promo", type: "video", version: 1, settings: {} }]), message: /./ },
      { theme: pages(DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, version: 2 }))), message: /./ },
      { theme: pages(DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, id: "same" }))), message: /^Section ids must be unique\.$/ },
    ];

    for (const { theme, message } of invalid) {
      const document = theme as StorefrontThemeDocument;
      await expect(saveThemeDraft(db, document, 0, 0)).rejects.toMatchObject({
        status: 400,
        code: "validation_error",
        message: expect.stringMatching(message),
      });
    }
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 0 });
    for (const table of ["theme_settings", "theme_settings_drafts", "theme_settings_versions"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("publishes a first draft as revision one exactly once", async () => {
    const firstTheme = storefrontTemplateTheme("marketplace");
    await expect(saveThemeDraft(db, firstTheme, 0, 0)).resolves.toMatchObject({ revision: 1, basePublishedRevision: 0 });
    await expect(saveThemeDraft(db, firstTheme, 0, 0)).rejects.toMatchObject({ status: 409 });
    await expect(publishThemeDraft(db, 0, 1)).resolves.toMatchObject({
      published: { revision: 1 },
      draft: { revision: 2, basePublishedRevision: 1 },
      draftDiffersFromLive: false,
    });

    await expect(publishThemeDraft(db, 0, 1)).rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: firstTheme, revision: 1 });
  });

  it("bounds stored documents by UTF-8 bytes before any draft write", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.landing["large-campaign"] = {
      title: "Campaign", description: "",
      sections: Array.from({ length: 9 }, (_, index) => ({
        ...storefrontSectionDefault("faq", `faq-${index}`),
        type: "faq" as const,
        settings: { heading: "", items: Array.from({ length: 20 }, () => ({ question: "Offer?", answer: "বাংলা".repeat(200) })) },
      })),
    };
    expect(JSON.stringify(theme).length).toBeLessThan(THEME_DOCUMENT_MAX_BYTES);
    await expect(saveThemeDraft(db, theme, 0, 0)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("too large") });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM theme_settings_drafts").get()).toEqual({ count: 0 });
  });

  it("keeps every draft based on the live revision, so a stale editor can only reload", async () => {
    seedPublishedWorkspace();
    // Session A loaded draft 1 on live 1; session B then saves and publishes.
    await saveThemeDraft(db, storefrontTemplateTheme("daily-essentials"), 1, 1, "admin_b");
    await publishThemeDraft(db, 1, 2, "admin_b");
    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { revision: 2 },
      draft: { revision: 3, basePublishedRevision: 2 },
    });

    await expect(saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1, "admin_a"))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(publishThemeDraft(db, 1, 1, "admin_a"))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(restoreThemeVersion(db, 1, 1, 1, "admin_a")).rejects.toMatchObject({ status: 409 });
    await expect(discardThemeDraft(db, 3, 1, "admin_a")).rejects.toMatchObject({ status: 409 });

    // A restore changes only the draft and preserves live.
    await restoreThemeVersion(db, 1, 3, 2, "admin_b");
    const workspace = await getThemeWorkspace(db);
    expect(workspace.draft.basePublishedRevision).toBe(workspace.published.revision);
    expect(workspace.published.revision).toBe(2);
    expect(workspace.draft.theme).toEqual(DEFAULT_STOREFRONT_THEME);
    expect(workspace.draft.revision).toBe(4);
  });

  it("saves a durable draft with its own CAS authority", async () => {
    seedPublishedWorkspace();
    const draftTheme = storefrontTemplateTheme("daily-essentials");

    const saved = await saveThemeDraft(db, draftTheme, 1, 1, "admin_1");
    expect(saved).toMatchObject({
      theme: draftTheme,
      revision: 2,
      basePublishedRevision: 1,
    });

    await expect(
      saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1, "admin_2"),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: draftTheme, revision: 2, basePublishedRevision: 1 },
      draftDiffersFromLive: true,
    });
  });

  it("publishes the exact saved draft and advances both authorities atomically", async () => {
    seedPublishedWorkspace();
    const draftTheme = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, draftTheme, 1, 1, "admin_1");

    const published = await publishThemeDraft(db, 1, 2, "admin_1");
    expect(published).toMatchObject({
      published: { revision: 2 },
      draft: { revision: 3, basePublishedRevision: 2 },
    });
    expect(await listThemeVersions(db)).toMatchObject([
      { revision: 2, source: "publish", sourceRevision: null, publishedBy: "admin_1" },
      { revision: 1, source: "migration" },
    ]);
    expect((await listThemeVersions(db))[0]).not.toHaveProperty("theme");
    expect((await getThemeVersion(db, 2)).theme).toEqual(draftTheme);

    await expect(publishThemeDraft(db, 1, 2, "admin_2"))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: draftTheme, revision: 2 });
    await expect(getThemeWorkspace(db)).resolves.toMatchObject({ draft: { theme: draftTheme }, draftDiffersFromLive: false });
  });

  it("restores history only to the draft and requires explicit publication", async () => {
    const originalTheme = storefrontTemplateTheme("marketplace");
    seedPublishedWorkspace({ theme: originalTheme });
    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1, "admin_1");
    await publishThemeDraft(db, 1, 2, "admin_1");

    const restored = await restoreThemeVersion(db, 1, 3, 2, "admin_2");
    expect(restored).toMatchObject({ published: { revision: 2 }, draft: { revision: 4, basePublishedRevision: 2 }, draftDiffersFromLive: true });
    expect((await getThemeSettings(db)).theme).toEqual(storefrontTemplateTheme("boutique"));
    expect((await getThemeWorkspace(db)).draft.theme).toEqual(originalTheme);
    expect(await listThemeVersions(db)).toHaveLength(2);
    await publishThemeDraft(db, 2, 4, "admin_2");
    expect((await listThemeVersions(db))[0]).toMatchObject({ revision: 3, source: "publish", sourceRevision: null, publishedBy: "admin_2" });
    expect((await getThemeVersion(db, 3)).theme).toEqual(originalTheme);
    await expect(restoreThemeVersion(db, 99, 5, 3)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a version naming images deleted since, with how many, and restores it without them when asked", async () => {
    sqlite.exec(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
      ('media_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready'),
      ('media_slide', 'slide.jpg', 'image', 'media/slide.jpg', 1, 'image/jpeg', 'ready'),
      ('media_kept', 'kept.jpg', 'image', 'media/kept.jpg', 1, 'image/jpeg', 'ready')`);
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.brand.logo = "media_logo";
    const heroIndex = theme.pages.home.findIndex((section) => section.type === "hero");
    const slide = { image: "media_slide", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: null };
    theme.pages.home[heroIndex] = { ...theme.pages.home[heroIndex]!, settings: { ...theme.pages.home[heroIndex]!.settings, slides: [slide, { ...slide, image: "media_kept" }] } } as never;
    seedPublishedWorkspace();
    await saveThemeDraft(db, theme, 1, 1, "admin_1");
    await publishThemeDraft(db, 1, 2, "admin_1");
    await saveThemeDraft(db, DEFAULT_STOREFRONT_THEME, 3, 2, "admin_1");
    // Both images leave Files after version 2 was published.
    sqlite.exec(`UPDATE media SET status = 'deleted', trashed_at = unixepoch(), deleted_at = unixepoch() WHERE id IN ('media_logo', 'media_slide')`);

    await expect(restoreThemeVersion(db, 2, 4, 2, "admin_2")).rejects.toMatchObject({
      status: 400, code: "theme_version_images_missing", details: { missingImages: 2 },
    });
    expect((await getThemeWorkspace(db)).draft.revision).toBe(4);

    const restored = await restoreThemeVersion(db, 2, 4, 2, "admin_2", { withoutMissingImages: true });
    expect(restored).toMatchObject({ draft: { revision: 5 }, draftDiffersFromLive: true });
    const draft = (await getThemeWorkspace(db)).draft.theme;
    expect(draft.brand.logo).toBeNull();
    expect(draft.pages.home[heroIndex]!.settings).toMatchObject({ slides: [{ image: "media_kept" }] });
    // The published version itself is unchanged.
    expect((await getThemeVersion(db, 2)).theme.brand.logo).toBe("media_logo");
  });

  it("records what changed, the merchant's note and the author on every publish", async () => {
    seedPublishedWorkspace();
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES ('staff_1', 'ফারহানা', 'farhana@example.test')").run();
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    const [first, second] = theme.pages.home;
    if (!first || !second) throw new Error("Need two default sections.");
    theme.pages.home = [second, { ...first, hidden: true }, { ...first, id: "campaign" }];
    await saveThemeDraft(db, theme, 1, 1, "staff_1");
    const published = await publishThemeDraft(db, 1, 2, "staff_1", "  Eid launch  ");
    expect(published.lastPublished).toMatchObject({ revision: 2, publishedBy: "staff_1", publishedByName: "ফারহানা" });
    expect(published.draftDiffersFromLive).toBe(false);
    const [version] = await listThemeVersions(db);
    expect(version).toMatchObject({ revision: 2, note: "Eid launch", publishedByName: "ফারহানা", moreChanges: 0 });
    expect(version!.changes).toContainEqual({ kind: "section-added", page: "home", sectionId: "campaign", sectionType: first.type });
    expect(version!.changes).toContainEqual({ kind: "section-changed", page: "home", sectionId: first.id, sectionType: first.type });
    expect(version!.changes).toContainEqual({ kind: "sections-reordered", page: "home" });
    expect((await getThemeVersion(db, 2)).theme).toEqual(theme);
    expect((await getThemeWorkspace(db)).lastPublished).toEqual(published.lastPublished);
    await expect(publishThemeDraft(db, 2, 3, "staff_1", "x".repeat(501))).rejects.toMatchObject({ status: 400 });
  });

  it("keeps a bounded change list and counts the rest", async () => {
    seedPublishedWorkspace();
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.landing = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`page-${index}`, {
      title: `Page ${index}`, description: "", sections: [],
    }]));
    theme.pages.home = Array.from({ length: 24 }, (_, index) => storefrontSectionDefault("faq", `faq-${index}`));
    const total = compareThemeDocuments(DEFAULT_STOREFRONT_THEME, theme).length;
    expect(total).toBeGreaterThan(44);
    await saveThemeDraft(db, theme, 1, 1);
    await publishThemeDraft(db, 1, 2);
    const [version] = await listThemeVersions(db);
    expect(version!.changes).toHaveLength(20);
    expect(version!.moreChanges).toBe(total - 20);
  });

  it("pages the history back without documents", async () => {
    seedPublishedWorkspace();
    let draft = 1;
    for (let live = 1; live <= 12; live += 1) {
      const theme = storefrontTemplateTheme(live % 2 ? "boutique" : "marketplace");
      draft = (await saveThemeDraft(db, theme, draft, live)).revision;
      draft = (await publishThemeDraft(db, live, draft)).draft.revision;
    }
    const first = await listThemeVersions(db);
    expect(first.map((version) => version.revision)).toEqual([13, 12, 11, 10, 9]);
    const next = await listThemeVersions(db, { beforeRevision: 4, limit: 50 });
    expect(await listThemeVersions(db, { beforeRevision: 9 })).toHaveLength(5);
    expect(next.map((version) => version.revision)).toEqual([3, 2, 1]);
  });

  it("discards to live with a fresh revision and rejects stale restore, discard and save", async () => {
    seedPublishedWorkspace();
    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1);
    expect((await getThemeWorkspace(db)).draftDiffersFromLive).toBe(true);
    const discarded = await discardThemeDraft(db, 2, 1, "staff_2");
    expect(discarded).toMatchObject({ published: { revision: 1 }, draft: { revision: 3, basePublishedRevision: 1 }, draftDiffersFromLive: false });
    expect((await getThemeWorkspace(db)).draft.theme).toEqual(DEFAULT_STOREFRONT_THEME);
    await expect(discardThemeDraft(db, 2, 1)).rejects.toMatchObject({ status: 409 });
    await expect(restoreThemeVersion(db, 1, 2, 1)).rejects.toMatchObject({ status: 409 });
    await expect(saveThemeDraft(db, storefrontTemplateTheme("marketplace"), 2, 1)).rejects.toMatchObject({ status: 409 });
    expect(await listThemeVersions(db)).toHaveLength(1);
  });

  it("discards and restores before any draft exists by creating it", async () => {
    seedPublishedWorkspace();
    sqlite.exec("DELETE FROM theme_settings_drafts");
    await expect(discardThemeDraft(db, 0, 1)).resolves.toMatchObject({ draft: { revision: 1, basePublishedRevision: 1 } });
    sqlite.exec("DELETE FROM theme_settings_drafts");
    await expect(restoreThemeVersion(db, 1, 0, 1)).resolves.toMatchObject({ draft: { revision: 1 } });
  });

  it("edits a landing page or the homepage through the same CAS and preserves the rest of the theme", async () => {
    seedPublishedWorkspace();
    const page = { title: "Eid campaign", description: "Gifts", sections: structuredClone(DEFAULT_STOREFRONT_THEME.pages.home) };
    const saved = await saveThemePageDraft(db, { page: "landing", slug: "eid-offers", value: page }, 1, 1, "staff_1");
    expect(saved.theme.pages.landing["eid-offers"]).toEqual(page);
    expect(saved.theme.tokens).toEqual(DEFAULT_STOREFRONT_THEME.tokens);
    await expect(saveThemePageDraft(db, { page: "landing", slug: "another", value: page }, 1, 1, "staff_2")).rejects.toMatchObject({ status: 409 });
    expect((await getThemeSettings(db)).theme.pages.landing).toEqual({});
    await saveThemePageDraft(db, { page: "landing", slug: "eid-offers", value: null }, 2, 1, "staff_1");
    expect((await getThemeWorkspace(db)).draft.theme.pages.landing).toEqual({});
    await saveThemePageDraft(db, { page: "home", value: [] }, 3, 1, "staff_1");
    expect((await getThemeWorkspace(db)).draft.theme.pages.home).toEqual([]);
  });

  it("previews an immutable history version while draft edits advance and fails closed after retention deletes it", async () => {
    seedPublishedWorkspace();
    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, 1);
    const preview = await createThemePreviewSession(db, 2, "staff_1", 1);
    const { token } = await exchangeThemePreviewContinuation(db, preview.continuationId);
    expect(preview.continuationId).toHaveLength(52);
    expect(token).toHaveLength(52);
    await saveThemeDraft(db, storefrontTemplateTheme("marketplace"), 2, 1);
    expect((await resolveThemePreviewSession(db, token))?.theme).toEqual(DEFAULT_STOREFRONT_THEME);
    const forged = token.replace("V0000000001", "V0000000002");
    expect(await resolveThemePreviewSession(db, forged)).toBeNull();
    sqlite.exec("DELETE FROM theme_settings_versions");
    expect(await resolveThemePreviewSession(db, token)).toBeNull();
  });

  it("keeps draft previews distinct even when random bytes resemble a historical version selector", async () => {
    seedPublishedWorkspace();
    const draft = storefrontTemplateTheme("marketplace");
    await saveThemeDraft(db, draft, 1, 1);
    const random = vi.mocked(ids.nanoid).mockImplementation((size = 21) => `V0000000001_${"a".repeat(36)}`.slice(0, size));
    try {
      const preview = await createThemePreviewSession(db, 2);
      const { token } = await exchangeThemePreviewContinuation(db, preview.continuationId);
      expect(token).toHaveLength(52);
      expect((await resolveThemePreviewSession(db, token))?.theme).toEqual(draft);
    } finally { random.mockRestore(); }
  });

  it("stores only token hashes and no theme, exchanges a continuation once, and follows the latest saved draft", async () => {
    seedPublishedWorkspace();
    const firstDraft = storefrontTemplateTheme("marketplace");
    const secondDraft = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, firstDraft, 1, 1, "admin_1");
    const preview = await createThemePreviewSession(db, 2, "admin_1");
    expect(preview).toMatchObject({ draftRevision: 2, basePublishedRevision: 1 });

    const stored = sqlite.prepare("SELECT * FROM theme_preview_sessions").get() as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["created_at", "created_by", "expires_at", "token_hash"]);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toContain(preview.continuationId);

    const exchanged = await exchangeThemePreviewContinuation(db, preview.continuationId);
    expect(exchanged.token).toMatch(/^tpv_[A-Za-z0-9_-]{48}$/);
    expect(Object.keys(exchanged).sort()).toEqual(["expiresAt", "token"]);
    await expect(
      exchangeThemePreviewContinuation(db, preview.continuationId),
    ).rejects.toThrow("unavailable or expired");
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toMatchObject({
      theme: firstDraft,
      draftRevision: 2,
      basePublishedRevision: 1,
    });

    // The next Save is what a refreshed preview tab shows, not a snapshot.
    await saveThemeDraft(db, secondDraft, 2, 1, "admin_1");
    batchCalls = 0;
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toMatchObject({
      theme: secondDraft,
      draftRevision: 3,
      basePublishedRevision: 1,
    });
    expect(batchCalls).toBe(1);

    // Publishing synchronizes the draft; the preview follows it.
    await publishThemeDraft(db, 1, 3, "admin_1");
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toMatchObject({
      theme: secondDraft,
      draftRevision: 4,
      basePublishedRevision: 2,
    });

    sqlite.exec("UPDATE theme_preview_sessions SET expires_at = 0");
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toBeNull();
  });

  it("fails closed when the draft a live preview follows is unreadable", async () => {
    seedPublishedWorkspace();
    const preview = await createThemePreviewSession(db, 1, "admin_1");
    const { token } = await exchangeThemePreviewContinuation(db, preview.continuationId);
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?").run("{broken");
    await expect(resolveThemePreviewSession(db, token)).rejects.toMatchObject({ status: 503 });
  });

  it("deletes expired preview rows wherever previews are read or created", async () => {
    seedPublishedWorkspace();
    const count = () => (sqlite.prepare("SELECT COUNT(*) AS count FROM theme_preview_sessions").get() as { count: number }).count;
    const expire = () => sqlite.prepare(`
      INSERT INTO theme_preview_sessions (token_hash, expires_at, created_by, created_at)
      VALUES (?, 1, NULL, 1)
    `).run(`expired_${count()}`);

    expire();
    const first = await createThemePreviewSession(db, 1, "admin_1");
    expect(count()).toBe(1);

    expire();
    const { token } = await exchangeThemePreviewContinuation(db, first.continuationId);
    expect(count()).toBe(1);

    expire();
    await expect(resolveThemePreviewSession(db, token)).resolves.not.toBeNull();
    expect(count()).toBe(1);
  });
});

describe.each(["d1", "turso"] as const)("theme history retention on %s", (provider) => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite({ provider });
    db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
  });

  afterEach(() => sqlite.close());

  function versionRevisions(): number[] {
    return (sqlite.prepare("SELECT published_revision AS revision FROM theme_settings_versions ORDER BY published_revision")
      .all() as Array<{ revision: number }>).map((row) => row.revision);
  }

  it("keeps the newest versions the history list can show when publishing or restoring", async () => {
    const serialized = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    const live = THEME_VERSION_HISTORY_LIMIT + 2;
    sqlite.prepare(`
      INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, ?, 1, 1)
    `).run(serialized, live);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 1, ?, NULL, 1, 1)
    `).run(serialized, live);
    const insertVersion = sqlite.prepare(`
      INSERT INTO theme_settings_versions (id, published_revision, theme, source, source_revision, published_by, created_at)
      VALUES (?, ?, ?, 'publish', NULL, NULL, 1)
    `);
    // One gap: retention counts versions, not revision numbers.
    for (let revision = 1; revision <= live; revision += 1) {
      if (revision !== 10) insertVersion.run(`themev_${revision}`, revision, serialized);
    }
    expect(versionRevisions()).toHaveLength(live - 1);

    await saveThemeDraft(db, storefrontTemplateTheme("boutique"), 1, live);
    await publishThemeDraft(db, live, 2);
    const afterPublish = versionRevisions();
    expect(afterPublish).toHaveLength(THEME_VERSION_HISTORY_LIMIT);
    expect(afterPublish.at(-1)).toBe(live + 1);
    expect(afterPublish[0]).toBe(live + 1 - THEME_VERSION_HISTORY_LIMIT);

    await restoreThemeVersion(db, live, 3, live + 1);
    expect(versionRevisions()).toEqual(afterPublish);
    await publishThemeDraft(db, live + 1, 4);
    const afterRestore = versionRevisions();
    expect(afterRestore).toHaveLength(THEME_VERSION_HISTORY_LIMIT);
    expect(afterRestore.at(-1)).toBe(live + 2);
    expect(afterRestore).not.toContain(live + 1 - THEME_VERSION_HISTORY_LIMIT);
  });

  it("leaves history untouched when a publish conflicts", async () => {
    const serialized = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 1, 1, NULL, 1, 1)
    `).run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_versions (id, published_revision, theme, source, source_revision, published_by, created_at)
      VALUES ('themev_1', 1, ?, 'migration', NULL, NULL, 1)
    `).run(serialized);

    await expect(publishThemeDraft(db, 1, 5)).rejects.toMatchObject({ status: 409 });
    expect(versionRevisions()).toEqual([1]);
  });
});

describe("theme document resets (0093 to version 5, 0106 to version 6)", () => {
  function seedBefore0093(published: string, draft: string, history: string) {
    const sqlite = createMigratedSqlite({ beforeMigration: "0093_" });
    sqlite.prepare(`
      INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
      VALUES ('default', ?, 3, 1, 1)
    `).run(published);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (
        id, theme, revision, base_published_revision, updated_by, created_at, updated_at
      ) VALUES ('default', ?, 4, 3, NULL, 1, 1)
    `).run(draft);
    sqlite.prepare(`
      INSERT INTO theme_settings_versions (
        id, published_revision, theme, source, source_revision, published_by, created_at
      ) VALUES ('themev_old', 2, ?, 'publish', NULL, NULL, 1), ('themev_current', 3, ?, 'publish', NULL, NULL, 1)
    `).run(history, published);
    sqlite.prepare(`
      INSERT INTO theme_preview_sessions (
        token_hash, theme, draft_revision, base_published_revision, expires_at, created_by, created_at
      ) VALUES ('hash_old', ?, 4, 3, 4102444800, NULL, 1)
    `).run(history);
    sqlite.exec(compiledMigrationSql("d1", undefined, "0093_"));
    return createSqliteD1Database({ sqlite });
  }

  function countRows(sqlite: DatabaseSync, table: string): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  it.each([
    ["version 1", V1_THEME, V1_THEME],
    ["version 3", V3_THEME, V1_THEME],
    ["version 4", V4_THEME, V3_THEME],
  ])("lets the Theme page read the defaults at revision zero after migrating a %s theme", async (_label, published, history) => {
    const { sqlite, db } = seedBefore0093(published, published, history);
    try {
      await expect(getThemeSettings(db)).resolves.toEqual({
        theme: DEFAULT_STOREFRONT_THEME,
        revision: 0,
      });
      await expect(getThemeWorkspace(db)).resolves.toMatchObject({
        published: { theme: DEFAULT_STOREFRONT_THEME, revision: 0 },
        draft: { theme: DEFAULT_STOREFRONT_THEME, revision: 0, basePublishedRevision: 0 },
      });
      await expect(listThemeVersions(db)).resolves.toEqual([]);
      expect(countRows(sqlite, "theme_settings_drafts")).toBe(0);
      expect(countRows(sqlite, "theme_preview_sessions")).toBe(0);
      // The first draft published after the reset claims revision one.
      await saveThemeDraft(db, DEFAULT_STOREFRONT_THEME, 0, 0);
      await expect(publishThemeDraft(db, 0, 1))
        .resolves.toMatchObject({ published: { revision: 1 } });
    } finally {
      sqlite.close();
    }
  });

  it("resets a version 5 published theme to the defaults at revision zero (0106)", async () => {
    const v5 = JSON.stringify({ ...storefrontTemplateTheme("boutique"), version: 5 });
    const sqlite = createMigratedSqlite({ beforeMigration: "0106_" });
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 3, 1, 1)").run(v5);
    sqlite.exec(compiledMigrationSql("d1", "0107_", "0106_"));
    const { db } = createSqliteD1Database({ sqlite });
    try {
      await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 0 });
      expect(countRows(sqlite, "theme_settings")).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
