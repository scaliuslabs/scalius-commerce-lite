import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
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
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function resultRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: resultRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });

  return {
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = resultRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

describe("versioned storefront theme settings", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let batchCalls: number;

  beforeEach(() => {
    batchCalls = 0;
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE (key, category)
      );
      CREATE TABLE theme_settings (
        id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
        colors TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (id = 'default')
      );
      CREATE TABLE theme_settings_drafts (
        id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
        theme TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        base_published_revision INTEGER NOT NULL CHECK (base_published_revision >= 0),
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (id = 'default')
      );
      CREATE TABLE theme_settings_versions (
        id TEXT PRIMARY KEY NOT NULL,
        published_revision INTEGER NOT NULL UNIQUE CHECK (published_revision >= 1),
        theme TEXT NOT NULL,
        source TEXT NOT NULL,
        source_revision INTEGER CHECK (source_revision IS NULL OR source_revision >= 1),
        published_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE theme_preview_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        theme TEXT NOT NULL,
        draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
        base_published_revision INTEGER NOT NULL CHECK (base_published_revision >= 0),
        expires_at INTEGER NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX theme_preview_sessions_expires_at_idx
        ON theme_preview_sessions (expires_at);
    `);
    const client = {
      prepare: (query: string) => createD1Statement(sqlite, query),
      batch: async (statements: SqliteD1Statement[]) => {
        batchCalls += 1;
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = drizzle(client as unknown as D1Database, { schema }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  function seedPublishedWorkspace({
    theme = DEFAULT_STOREFRONT_THEME_SETTINGS,
    publishedRevision = 1,
    draftRevision = 1,
  }: {
    theme?: typeof DEFAULT_STOREFRONT_THEME_SETTINGS;
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

  it("reads and sanitizes the legacy color row before the first versioned publish", async () => {
    sqlite.prepare(`
      INSERT INTO settings (id, key, value, type, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "legacy_theme",
      "storefront_colors",
      JSON.stringify({ primary: " #2563eb ", unsafe: "url(evil)" }),
      "string",
      "theme",
      1,
    );

    await expect(getThemeSettings(db)).resolves.toEqual({
      theme: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: { primary: "#2563eb" },
      },
      revision: 0,
    });
  });

  it("loads the normal published and draft workspace in one provider batch", async () => {
    seedPublishedWorkspace();

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { revision: 1 },
      draft: { revision: 1, basePublishedRevision: 1 },
    });
    expect(batchCalls).toBe(1);
  });

  it("fails closed when the versioned semantic document is unreadable", async () => {
    sqlite.prepare(`
      INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
      VALUES ('default', ?, 1, 1, 1)
    `).run(JSON.stringify({
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      typography: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS.typography,
        heading: "remote-font",
      },
    }));

    await expect(getThemeSettings(db)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("does not misclassify a partial semantic document as legacy colors", async () => {
    sqlite.prepare(`
      INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
      VALUES ('default', ?, 1, 1, 1)
    `).run(JSON.stringify({
      typography: DEFAULT_STOREFRONT_THEME_SETTINGS.typography,
      cornerStyle: DEFAULT_STOREFRONT_THEME_SETTINGS.cornerStyle,
      density: DEFAULT_STOREFRONT_THEME_SETTINGS.density,
      containerWidth: DEFAULT_STOREFRONT_THEME_SETTINGS.containerWidth,
      components: DEFAULT_STOREFRONT_THEME_SETTINGS.components,
    }));

    await expect(getThemeSettings(db)).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("claims revision one exactly once when publishing a legacy draft", async () => {
    const firstTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#047857" },
    };
    const first = await saveThemeSettings(db, firstTheme, 0);
    expect(first).toEqual({ theme: firstTheme, revision: 1 });

    await expect(
      saveThemeSettings(db, { ...firstTheme, colors: { primary: "#be123c" } }, 0),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(first);
  });

  it("rejects a stale publish without replacing the current storefront colors", async () => {
    await saveThemeSettings(db, {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#18181b" },
    }, 0);
    const current = await saveThemeSettings(db, {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#2563eb" },
      density: "compact",
    }, 1);
    expect(current.revision).toBe(2);

    await expect(
      saveThemeSettings(db, {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: { primary: "#be123c" },
      }, 1),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(current);
  });

  it("saves a durable draft with its own CAS authority", async () => {
    seedPublishedWorkspace();
    const draftTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      density: "compact" as const,
      colors: { primary: "#047857" },
    };

    const saved = await saveThemeDraft(db, draftTheme, 1, 1, "admin_1");
    expect(saved).toMatchObject({
      theme: draftTheme,
      revision: 2,
      basePublishedRevision: 1,
    });

    await expect(
      saveThemeDraft(db, {
        ...draftTheme,
        colors: { primary: "#be123c" },
      }, 1, 1, "admin_2"),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

    await expect(getThemeWorkspace(db)).resolves.toMatchObject({
      published: { theme: DEFAULT_STOREFRONT_THEME_SETTINGS, revision: 1 },
      draft: { theme: draftTheme, revision: 2, basePublishedRevision: 1 },
    });
  });

  it("publishes the exact saved draft and advances both authorities atomically", async () => {
    seedPublishedWorkspace();
    const draftTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      cornerStyle: "square" as const,
      colors: { primary: "#1d4ed8" },
    };
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
    const originalTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#18181b" },
    };
    seedPublishedWorkspace({ theme: originalTheme });
    const secondTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      typography: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS.typography,
        heading: "editorial" as const,
      },
    };
    await saveThemeDraft(db, secondTheme, 1, 1, "admin_1");
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
    const firstDraft = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      density: "compact" as const,
    };
    const secondDraft = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      density: "comfortable" as const,
      cornerStyle: "subtle" as const,
    };
    await saveThemeDraft(db, firstDraft, 1, 1, "admin_1");
    const preview = await createThemePreviewSession(db, 2, "admin_1");

    const stored = sqlite.prepare(`
      SELECT token_hash AS tokenHash, theme FROM theme_preview_sessions
    `).get() as { tokenHash: string; theme: string };
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toContain(preview.continuationId);
    expect(stored.theme).toBe(JSON.stringify(firstDraft));

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
