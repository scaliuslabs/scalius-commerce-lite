import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
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
  THEME_VERSION_HISTORY_LIMIT,
} from "./site-settings.service";
import {
  DEFAULT_STOREFRONT_THEME,
  storefrontTemplateTheme,
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

  it("fails closed on dashboard reads when the published row is not a valid version 5 document", async () => {
    const unknownFont = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as {
      tokens: { typography: string };
    };
    unknownFont.tokens.typography = "remote-font";
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME);
    lowContrast.tokens.colors.foreground = "#f5f5f5";

    for (const stored of [V1_THEME, V3_THEME, JSON.stringify(unknownFont), JSON.stringify(lowContrast), "{not json"]) {
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

  it("fails closed when a stored draft or history row is not a valid version 5 document", async () => {
    seedPublishedWorkspace();
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?").run(V3_THEME);
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
      { theme: { ...DEFAULT_STOREFRONT_THEME, version: 3 }, message: /./ },
      { theme: JSON.parse(V3_THEME), message: /./ },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          pages: { home: [...DEFAULT_STOREFRONT_THEME.pages.home, { id: "promo", type: "video", version: 1, settings: {} }] },
        },
        message: /./,
      },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          pages: { home: DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, version: 2 })) },
        },
        message: /./,
      },
      {
        theme: {
          ...DEFAULT_STOREFRONT_THEME,
          pages: { home: DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, id: "same" })) },
        },
        message: /^Section ids must be unique\.$/,
      },
    ];

    for (const { theme, message } of invalid) {
      const document = theme as StorefrontThemeDocument;
      await expect(saveThemeDraft(db, document, 0, 0)).rejects.toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
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
    await expect(publishThemeDraft(db, 0, 1)).resolves.toMatchObject({
      published: { theme: firstTheme, revision: 1 },
      draft: { theme: firstTheme, revision: 2, basePublishedRevision: 1 },
    });

    await expect(publishThemeDraft(db, 0, 1)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: firstTheme, revision: 1 });
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
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(publishThemeDraft(db, 1, 1, "admin_a"))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });

    // A restore moves live and the draft together too.
    await rollbackThemeSettings(db, 1, 2, 3, "admin_b");
    const workspace = await getThemeWorkspace(db);
    expect(workspace.draft.basePublishedRevision).toBe(workspace.published.revision);
    expect(workspace.published.revision).toBe(3);
    await expect(getThemeSettings(db)).resolves.toEqual({ theme: DEFAULT_STOREFRONT_THEME, revision: 3 });
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
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: draftTheme, revision: 2, basePublishedRevision: 1 },
    });
  });

  it("publishes the exact saved draft and advances both authorities atomically", async () => {
    seedPublishedWorkspace();
    const draftTheme = storefrontTemplateTheme("heritage-editorial");
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
    const originalTheme = storefrontTemplateTheme("rounded-tech");
    seedPublishedWorkspace({ theme: originalTheme });
    await saveThemeDraft(db, storefrontTemplateTheme("fashion-value"), 1, 1, "admin_1");
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
    sqlite.prepare("UPDATE theme_settings_drafts SET theme = ?").run(V3_THEME);
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
    expect(await listThemeVersions(db, THEME_VERSION_HISTORY_LIMIT)).toHaveLength(THEME_VERSION_HISTORY_LIMIT);

    await rollbackThemeSettings(db, live, live + 1, 3);
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

  it("keeps a version 6 published theme through 0106 and drops only its older history", async () => {
    const currentTheme = storefrontTemplateTheme("boutique");
    const serialized = JSON.stringify(currentTheme);
    const sqlite = createMigratedSqlite({ beforeMigration: "0106_" });
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 3, 1, 1)").run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
      VALUES ('default', ?, 4, 3, NULL, 1, 1)
    `).run(serialized);
    sqlite.prepare(`
      INSERT INTO theme_settings_versions (id, published_revision, theme, source, source_revision, published_by, created_at)
      VALUES ('themev_old', 2, ?, 'publish', NULL, NULL, 1), ('themev_current', 3, ?, 'publish', NULL, NULL, 1)
    `).run(V3_THEME, serialized);
    sqlite.exec(compiledMigrationSql("d1", "0107_", "0106_"));
    const { db } = createSqliteD1Database({ sqlite });
    try {
      await expect(getThemeSettings(db)).resolves.toEqual({ theme: currentTheme, revision: 3 });
      await expect(getThemeWorkspace(db)).resolves.toMatchObject({
        published: { theme: currentTheme, revision: 3 },
        draft: { theme: currentTheme, revision: 4, basePublishedRevision: 3 },
      });
      await expect(listThemeVersions(db)).resolves.toEqual([
        expect.objectContaining({ id: "themev_current", revision: 3, theme: currentTheme }),
      ]);
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
