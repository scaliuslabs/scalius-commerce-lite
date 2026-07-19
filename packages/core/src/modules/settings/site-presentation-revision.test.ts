import { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
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
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE site_settings (
        id TEXT PRIMARY KEY NOT NULL,
        singleton_key TEXT NOT NULL DEFAULT 'default' UNIQUE,
        logo TEXT,
        favicon TEXT,
        site_name TEXT NOT NULL,
        site_description TEXT,
        header_config TEXT NOT NULL,
        header_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (header_config_revision >= 1),
        footer_config TEXT NOT NULL,
        footer_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (footer_config_revision >= 1),
        social_links TEXT,
        contact_info TEXT,
        site_title TEXT,
        homepage_title TEXT,
        homepage_meta_description TEXT,
        homepage_config TEXT NOT NULL DEFAULT '{}',
        homepage_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (homepage_config_revision >= 1),
        robots_txt TEXT,
        storefront_url TEXT DEFAULT '/',
        auth_verification_method TEXT NOT NULL DEFAULT 'email',
        guest_checkout_enabled INTEGER NOT NULL DEFAULT 1,
        checkout_mode TEXT NOT NULL DEFAULT 'all',
        partial_payment_enabled INTEGER NOT NULL DEFAULT 0,
        partial_payment_amount REAL NOT NULL DEFAULT 0,
        checkout_flow_revision INTEGER NOT NULL DEFAULT 1,
        whatsapp_access_token TEXT,
        whatsapp_phone_number_id TEXT,
        whatsapp_template_name TEXT DEFAULT 'auth_otp',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db = drizzle(async (query, params, method) => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
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
