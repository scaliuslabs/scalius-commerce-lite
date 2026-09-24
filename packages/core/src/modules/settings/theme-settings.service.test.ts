import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
} from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createThemePreviewSession,
  exchangeThemePreviewContinuation,
  getThemeSettings,
  getThemeWorkspace,
  listThemeVersions,
  publishThemeDraft,
  resolveThemePreviewSession,
  rollbackThemeSettings,
  saveThemeDraft,
  saveThemeSettings,
} from "./site-settings.service";
import {
  DEFAULT_STOREFRONT_THEME,
  storefrontStylePresetTheme,
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
    productCard: { imageRatio: "square", hoverImage: false, quickBuy: false, badge: "top-left" },
    grid: { desktop: 4, mobile: 2 },
    productPage: { gallery: "carousel", thumbnails: "below" },
    homepage: ["hero", "collections", "categories", "delivery"],
  },
});

/**
 * A version 2 document: separate heading/body fonts, no button shape and no
 * navigation styles.
 */
const V2_THEME = (() => {
  const { navigation: _navigation, mobileNavigation: _mobileNavigation, ...layout } =
    DEFAULT_STOREFRONT_THEME.layout;
  const { buttonShape: _buttonShape, ...tokens } = DEFAULT_STOREFRONT_THEME.tokens;
  return JSON.stringify({
    ...DEFAULT_STOREFRONT_THEME,
    version: 2,
    tokens: { ...tokens, typography: { heading: "system", body: "system" } },
    layout,
  });
})();

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

  it("fails closed on dashboard reads when the published row is not a valid version 3 document", async () => {
    const unknownFont = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as {
      tokens: { typography: string };
    };
    unknownFont.tokens.typography = "remote-font";
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME);
    lowContrast.tokens.colors.foreground = "#f5f5f5";

    for (const stored of [V1_THEME, V2_THEME, JSON.stringify(unknownFont), JSON.stringify(lowContrast), "{not json"]) {
      sqlite.exec("DELETE FROM theme_settings");
      sqlite.prepare(`
        INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
        VALUES ('default', ?, 1, 1, 1)
      `).run(stored);

      await expect(getThemeSettings(db)).rejects.toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Published storefront style is unreadable. Re-save it before editing.",
      });
      await expect(getThemeWorkspace(db)).rejects.toMatchObject({ status: 503 });
    }
  });

  it("fails closed when a stored draft or history row is not a valid version 3 document", async () => {
    seedPublishedWorkspace();
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?").run(V2_THEME);
    await expect(getThemeWorkspace(db)).rejects.toMatchObject({ status: 503 });
    await expect(publishThemeDraft(db, 1, 1)).rejects.toMatchObject({ status: 503 });

    sqlite.prepare("UPDATE theme_settings_versions SET theme = ?").run(V1_THEME);
    await expect(listThemeVersions(db)).rejects.toMatchObject({ status: 503 });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 1 });
  });

  it("rejects invalid writes with the first issue message and stores nothing", async () => {
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME);
    lowContrast.tokens.colors.foreground = "#f5f5f5";
    const invalid: Array<{ theme: unknown; message: RegExp }> = [
      {
        theme: lowContrast,
        message: /^foreground on background has contrast .* it needs at least 4\.5:1\.$/,
      },
      { theme: JSON.parse(V1_THEME), message: /./ },
      { theme: { ...DEFAULT_STOREFRONT_THEME, version: 1 }, message: /./ },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          sections: [...DEFAULT_STOREFRONT_THEME.sections, { id: "promo", type: "banner", version: 1, settings: {} }],
        },
        message: /./,
      },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          sections: DEFAULT_STOREFRONT_THEME.sections.map((section) => ({ ...section, version: 2 })),
        },
        message: /./,
      },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          sections: DEFAULT_STOREFRONT_THEME.sections.filter((section) => section.type !== "hero"),
        },
        message: /^A configured theme has the hero section exactly once\.$/,
      },
    ];

    for (const { theme, message } of invalid) {
      const document = theme as StorefrontThemeDocument;
      await expect(saveThemeSettings(db, document, 0)).rejects.toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(message),
      });
      await expect(saveThemeDraft(db, document, 0, 0)).rejects.toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 0 });
    for (const table of ["theme_settings", "theme_settings_drafts", "theme_settings_versions"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("claims revision one exactly once when publishing without a draft", async () => {
    const firstTheme = storefrontStylePresetTheme("marketplace");
    const first = await saveThemeSettings(db, firstTheme, 0);
    expect(first).toEqual({ theme: firstTheme, revision: 1 });

    await expect(
      saveThemeSettings(db, storefrontStylePresetTheme("boutique"), 0),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(first);
  });

  it("rejects a stale publish without replacing the current storefront style", async () => {
    await saveThemeSettings(db, storefrontStylePresetTheme("marketplace"), 0);
    const current = await saveThemeSettings(db, storefrontStylePresetTheme("daily"), 1);
    expect(current.revision).toBe(2);

    await expect(
      saveThemeSettings(db, storefrontStylePresetTheme("boutique"), 1),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(current);
  });

  it("saves a durable draft with its own CAS authority", async () => {
    seedPublishedWorkspace();
    const draftTheme = storefrontStylePresetTheme("daily");

    const saved = await saveThemeDraft(db, draftTheme, 1, 1, "admin_1");
    expect(saved).toMatchObject({
      theme: draftTheme,
      revision: 2,
      basePublishedRevision: 1,
    });

    await expect(
      saveThemeDraft(db, storefrontStylePresetTheme("boutique"), 1, 1, "admin_2"),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: draftTheme, revision: 2, basePublishedRevision: 1 },
    });
  });

  it("publishes the exact saved draft and advances both authorities atomically", async () => {
    seedPublishedWorkspace();
    const draftTheme = storefrontStylePresetTheme("heritage");
    await saveThemeDraft(db, draftTheme, 1, 1, "admin_1");

    const published = await publishThemeDraft(db, 1, 2, "admin_1");
    expect(published).toMatchObject({
      published: { theme: draftTheme, revision: 2 },
      draft: { theme: draftTheme, revision: 3, basePublishedRevision: 2 },
    });
    expect(await listThemeVersions(db)).toMatchObject([
      {
        revision: 2,
        theme: draftTheme,
        source: "publish",
        sourceRevision: null,
        publishedBy: "admin_1",
      },
      { revision: 1, source: "migration" },
    ]);

    await expect(publishThemeDraft(db, 1, 2, "admin_2"))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual({
      theme: draftTheme,
      revision: 2,
    });
  });

  it("restores history as a new immutable revision and synchronizes the draft", async () => {
    const originalTheme = storefrontStylePresetTheme("midnight");
    seedPublishedWorkspace({ theme: originalTheme });
    await saveThemeDraft(db, storefrontStylePresetTheme("beauty"), 1, 1, "admin_1");
    await publishThemeDraft(db, 1, 2, "admin_1");

    const restored = await rollbackThemeSettings(db, 1, 2, 3, "admin_2");
    expect(restored).toMatchObject({
      published: { theme: originalTheme, revision: 3 },
      draft: { theme: originalTheme, revision: 4, basePublishedRevision: 3 },
    });
    expect((await listThemeVersions(db))[0]).toMatchObject({
      revision: 3,
      source: "rollback",
      sourceRevision: 1,
      publishedBy: "admin_2",
      theme: originalTheme,
    });
  });

  it("stores only a continuation hash, exchanges it once, and resolves the immutable preview", async () => {
    seedPublishedWorkspace();
    const firstDraft = storefrontStylePresetTheme("marketplace");
    const secondDraft = storefrontStylePresetTheme("boutique");
    await saveThemeDraft(db, firstDraft, 1, 1, "admin_1");
    const preview = await createThemePreviewSession(db, 2, "admin_1");

    const stored = sqlite.prepare(`
      SELECT token_hash AS tokenHash, theme FROM theme_preview_sessions
    `).get() as { tokenHash: string; theme: string };
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toContain(preview.continuationId);
    expect(JSON.parse(stored.theme)).toEqual(firstDraft);

    await saveThemeDraft(db, secondDraft, 2, 1, "admin_1");
    const exchanged = await exchangeThemePreviewContinuation(
      db,
      preview.continuationId,
    );
    expect(exchanged.token).toMatch(/^tpv_[A-Za-z0-9_-]{48}$/);
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toMatchObject({
      theme: firstDraft,
      draftRevision: 2,
      basePublishedRevision: 1,
    });
    await expect(
      exchangeThemePreviewContinuation(db, preview.continuationId),
    ).rejects.toThrow("unavailable or expired");

    sqlite.exec("UPDATE theme_preview_sessions SET expires_at = 0");
    await expect(resolveThemePreviewSession(db, exchanged.token)).resolves.toBeNull();
  });
});

describe("migration 0081 resets theme documents that are not version 3", () => {
  function seedBefore0081(published: string, draft: string, history: string) {
    const sqlite = createMigratedSqlite({ beforeMigration: "0081_" });
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
    sqlite.exec(compiledMigrationSql("d1", undefined, "0081_"));
    return createSqliteD1Database({ sqlite });
  }

  function countRows(sqlite: DatabaseSync, table: string): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  it.each([
    ["version 1", V1_THEME, V1_THEME],
    ["version 2", V2_THEME, V1_THEME],
  ])("lets the Theme page read the defaults at revision zero after migrating a %s theme", async (_label, published, history) => {
    const { sqlite, db } = seedBefore0081(published, published, history);
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
      // The first save after the reset claims revision one.
      await expect(saveThemeSettings(db, DEFAULT_STOREFRONT_THEME, 0))
        .resolves.toMatchObject({ revision: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps a version 3 published theme and drops only its older history", async () => {
    const currentTheme = storefrontStylePresetTheme("boutique");
    const serialized = JSON.stringify(currentTheme);
    const { sqlite, db } = seedBefore0081(serialized, serialized, V2_THEME);
    try {
      await expect(getThemeSettings(db)).resolves.toEqual({
        theme: currentTheme,
        revision: 3,
      });
      await expect(getThemeWorkspace(db)).resolves.toMatchObject({
        published: { theme: currentTheme, revision: 3 },
        draft: { theme: currentTheme, revision: 4, basePublishedRevision: 3 },
      });
      await expect(listThemeVersions(db)).resolves.toEqual([
        expect.objectContaining({ id: "themev_current", revision: 3, theme: currentTheme }),
      ]);
      expect(countRows(sqlite, "theme_preview_sessions")).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
