import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0038_last_sentinel.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  CREATE TABLE site_settings (
    id TEXT PRIMARY KEY NOT NULL,
    singleton_key TEXT DEFAULT 'default' NOT NULL,
    logo TEXT,
    favicon TEXT,
    site_name TEXT NOT NULL,
    site_description TEXT,
    header_config TEXT NOT NULL,
    header_config_revision INTEGER DEFAULT 1 NOT NULL,
    footer_config TEXT NOT NULL,
    footer_config_revision INTEGER DEFAULT 1 NOT NULL,
    social_links TEXT,
    contact_info TEXT,
    site_title TEXT,
    homepage_title TEXT,
    homepage_meta_description TEXT,
    robots_txt TEXT,
    storefront_url TEXT DEFAULT '/',
    auth_verification_method TEXT DEFAULT 'email' NOT NULL,
    guest_checkout_enabled INTEGER DEFAULT true NOT NULL,
    checkout_mode TEXT DEFAULT 'all' NOT NULL,
    partial_payment_enabled INTEGER DEFAULT false NOT NULL,
    partial_payment_amount REAL DEFAULT 0 NOT NULL,
    checkout_flow_revision INTEGER DEFAULT 1 NOT NULL,
    whatsapp_access_token TEXT,
    whatsapp_phone_number_id TEXT,
    whatsapp_template_name TEXT DEFAULT 'auth_otp',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX site_settings_singleton_idx
    ON site_settings (singleton_key);
`;

describe("homepage presentation migration", () => {
  it("preserves site settings and starts with hidden homepage modules", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        INSERT INTO site_settings (
          id, site_name, header_config, header_config_revision,
          footer_config, footer_config_revision, storefront_url,
          checkout_flow_revision, created_at, updated_at
        ) VALUES (
          'settings_1', 'Demo', '{"logo":true}', 7,
          '{"tagline":"Hello"}', 5, 'https://store.example',
          3, 1700000000, 1700000001
        );
        ${migration}
        SELECT
          id || ':' || site_name || ':' || header_config_revision || ':' ||
          footer_config_revision || ':' || checkout_flow_revision || ':' ||
          homepage_config || ':' || homepage_config_revision
        FROM site_settings;
        PRAGMA foreign_key_check;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("settings_1:Demo:7:5:3:{}:1");
  });

  it("rejects non-positive homepage presentation revisions", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        ${migration}
        INSERT INTO site_settings (
          id, site_name, header_config, footer_config,
          homepage_config_revision, created_at, updated_at
        ) VALUES ('invalid', 'Demo', '{}', '{}', 0, 1700000000, 1700000000);
      `,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /site_settings_homepage_config_revision_positive|CHECK constraint failed/u,
    );
  });
});
