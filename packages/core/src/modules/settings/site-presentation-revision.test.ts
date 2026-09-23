import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getHomepagePresentationSettings,
  saveHomepagePresentationSettings,
  saveFooterConfig,
  saveHeaderConfig,
} from "./site-settings.service";

describe("header and footer settings revision authority", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  it("claims a missing singleton once and rejects a competing first writer", async () => {
    await expect(saveHeaderConfig(db, { topBar: { text: "", isEnabled: false } }, 0)).resolves.toEqual({
      revision: 1,
    });

    await expect(
      saveFooterConfig(db, { tagline: "" }, 0),
    ).rejects.toMatchObject({
      status: 409,
      code: "SITE_PRESENTATION_REVISION_CONFLICT",
      details: {
        section: "footer",
        expectedRevision: 0,
        currentRevision: 1,
      },
    });
  });

  it("increments each document independently and never accepts a stale write", async () => {
    sqlite.prepare(`
      INSERT INTO site_settings (
        id, singleton_key, site_name, site_description,
        header_config, header_config_revision,
        footer_config, footer_config_revision,
        created_at, updated_at
      ) VALUES ('settings_1', 'default', 'Store', '', '{}', 1, '{}', 1, 1, 1)
    `).run();

    await expect(
      saveHeaderConfig(db, { topBar: { text: "Hello", isEnabled: true } }, 1),
    ).resolves.toEqual({ revision: 2 });
    await expect(
      saveFooterConfig(db, { tagline: "Carefully made" }, 1),
    ).resolves.toEqual({ revision: 2 });

    await expect(
      saveHeaderConfig(db, {
        topBar: { text: "Stale", isEnabled: true },
      }, 1),
    ).rejects.toMatchObject({
      status: 409,
      code: "SITE_PRESENTATION_REVISION_CONFLICT",
      details: {
        section: "header",
        expectedRevision: 1,
        currentRevision: 2,
      },
    });

    const row = sqlite.prepare(`
      SELECT header_config_revision, footer_config_revision, header_config
      FROM site_settings WHERE singleton_key = 'default'
    `).get() as {
      header_config_revision: number;
      footer_config_revision: number;
      header_config: string;
    };
    expect(row.header_config_revision).toBe(2);
    expect(row.footer_config_revision).toBe(2);
    expect(JSON.parse(row.header_config)).toEqual({
      topBar: { text: "Hello", isEnabled: true },
    });
  });

  it("stores one ordered homepage document and rejects stale writes", async () => {
    sqlite.prepare(`
      INSERT INTO site_settings (
        id, singleton_key, site_name, site_description,
        header_config, footer_config, homepage_config,
        homepage_config_revision, created_at, updated_at
      ) VALUES ('settings_1', 'default', 'Store', '', '{}', '{}', '{}', 1, 1, 1)
    `).run();

    await expect(saveHomepagePresentationSettings(db, {
      categoryRail: {
        enabled: true,
        title: "Browse",
        categoryIds: ["cat-b", "cat-a", "cat-b"],
      },
      trustStrip: { enabled: true },
    }, 1)).resolves.toEqual({
      config: {
        categoryRail: {
          enabled: true,
          title: "Browse",
          categoryIds: ["cat-b", "cat-a"],
        },
        trustStrip: { enabled: true },
      },
      revision: 2,
    });

    await expect(saveHomepagePresentationSettings(db, {
      categoryRail: { enabled: false, title: "Stale", categoryIds: [] },
      trustStrip: { enabled: false },
    }, 1)).rejects.toMatchObject({
      status: 409,
      code: "HOMEPAGE_PRESENTATION_REVISION_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });

    await expect(getHomepagePresentationSettings(db)).resolves.toEqual({
      config: {
        categoryRail: {
          enabled: true,
          title: "Browse",
          categoryIds: ["cat-b", "cat-a"],
        },
        trustStrip: { enabled: true },
      },
      revision: 2,
    });
  });
});
