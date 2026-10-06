// PostgreSQL parity for the theme workflow batches: history retention in the
// publish batch and preview sessions that resolve the saved draft at read
// time. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server; the
// test creates and drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import {
  createThemePreviewSession,
  exchangeThemePreviewContinuation,
  publishThemeDraft,
  resolveThemePreviewSession,
  saveThemeDraft,
  THEME_VERSION_HISTORY_LIMIT,
} from "./site-settings.service";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.skipIf(!postgresUrl)("theme workflow on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("prunes history in the publish batch and resolves previews to the current draft", async () => {
    const { db, client } = await createNativePostgres({ label: "theme" });

    const serialized = JSON.stringify(DEFAULT_STOREFRONT_THEME);
    const live = THEME_VERSION_HISTORY_LIMIT + 1;
    await client.query(
      "INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', $1, $2, 1, 1)",
      [serialized, live],
    );
    await client.query(
      `INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision, updated_by, created_at, updated_at)
       VALUES ('default', $1, 1, $2, NULL, 1, 1)`,
      [serialized, live],
    );
    for (let revision = 1; revision <= live; revision += 1) {
      await client.query(
        `INSERT INTO theme_settings_versions (id, published_revision, theme, source, source_revision, published_by, created_at)
         VALUES ($1, $2, $3, 'publish', NULL, NULL, 1)`,
        [`themev_${revision}`, revision, serialized],
      );
    }

    const boutique = storefrontTemplateTheme("boutique");
    await saveThemeDraft(db, boutique, 1, live);
    await publishThemeDraft(db, live, 2);
    const versions = (await client.query<{ revision: string | number }>(
      "SELECT published_revision AS revision FROM theme_settings_versions ORDER BY published_revision",
    )).rows.map((row) => Number(row.revision));
    expect(versions).toHaveLength(THEME_VERSION_HISTORY_LIMIT);
    expect(versions[0]).toBe(live + 2 - THEME_VERSION_HISTORY_LIMIT);
    expect(versions.at(-1)).toBe(live + 1);

    await client.query(
      "INSERT INTO theme_preview_sessions (token_hash, expires_at, created_by, created_at) VALUES ('expired', 1, NULL, 1)",
    );
    const preview = await createThemePreviewSession(db, 3, "admin_1");
    const { token } = await exchangeThemePreviewContinuation(db, preview.continuationId);
    await expect(resolveThemePreviewSession(db, token)).resolves.toMatchObject({
      theme: boutique,
      draftRevision: 3,
      basePublishedRevision: live + 1,
    });
    const marketplace = storefrontTemplateTheme("marketplace");
    await saveThemeDraft(db, marketplace, 3, live + 1);
    await expect(resolveThemePreviewSession(db, token)).resolves.toMatchObject({
      theme: marketplace,
      draftRevision: 4,
    });
    const sessions = await client.query("SELECT token_hash FROM theme_preview_sessions");
    expect(sessions.rows).toHaveLength(1);

    await client.query("UPDATE theme_preview_sessions SET expires_at = 0");
    await expect(resolveThemePreviewSession(db, token)).resolves.toBeNull();
    expect((await client.query("SELECT token_hash FROM theme_preview_sessions")).rows).toHaveLength(0);
  });
});
