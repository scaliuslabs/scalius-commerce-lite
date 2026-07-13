import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0027_old_xorn.sql"),
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
    footer_config TEXT NOT NULL,
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
    whatsapp_access_token TEXT,
    whatsapp_phone_number_id TEXT,
    whatsapp_template_name TEXT DEFAULT 'auth_otp',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX site_settings_singleton_idx
    ON site_settings (singleton_key);
`;

describe("checkout flow revision migration", () => {
  it("preserves the legacy checkout document and initializes revision one", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        INSERT INTO site_settings (
          id, site_name, header_config, footer_config,
          guest_checkout_enabled, checkout_mode,
          partial_payment_enabled, partial_payment_amount,
          created_at, updated_at
        ) VALUES (
          'settings_1', 'Demo', '{}', '{}', false, 'gateways_only', true, 250,
          1700000000, 1700000001
        );
        ${migration}
        SELECT
          id || ':' || guest_checkout_enabled || ':' || checkout_mode || ':' ||
          partial_payment_enabled || ':' || partial_payment_amount || ':' ||
          checkout_flow_revision
        FROM site_settings;
        PRAGMA foreign_key_check;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("settings_1:0:gateways_only:1:250.0:1");
  });

  it("rejects non-positive checkout revisions after cutover", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${legacySchema}
        ${migration}
        INSERT INTO site_settings (
          id, site_name, header_config, footer_config,
          checkout_flow_revision, created_at, updated_at
        ) VALUES ('invalid', 'Demo', '{}', '{}', 0, 1700000000, 1700000000);
      `,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /site_settings_checkout_flow_revision_positive|CHECK constraint failed/u,
    );
  });
});
