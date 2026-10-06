import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
  createTaxRate,
  createTaxRegion,
  deleteTaxRate,
  deleteTaxRegion,
  getTaxRegion,
  listTaxRegions,
  updateTaxRate,
  updateTaxRegion,
  updateTaxSettings,
} from "./tax-admin.service";

describe("tax lifecycle D1 atomicity", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase() {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    return harness.db;
  }

  function seedEnabledTax(rateIds: string[]) {
    sqlite!.exec(`
      INSERT INTO tax_classes
        (id, name, description, is_exempt, version, created_at, updated_at, deleted_at)
      VALUES ('taxc_standard', 'Standard', NULL, 0, 1, 1, 1, NULL);
      INSERT INTO tax_settings
        (id, enabled, tax_shipping, default_tax_class_id,
         shipping_tax_class_id, display_label, version, created_at, updated_at)
      VALUES ('default', 1, 0, 'taxc_standard', NULL, 'Tax', 1, 1, 1);
      INSERT INTO tax_regions (id, country_code) VALUES ('txreg_bd', 'BD');
    `);
    const insertRate = sqlite!.prepare(`
      INSERT INTO tax_rates
        (id, tax_class_id, tax_region_id, name, rate_bps, priority, is_compound, is_active, version,
         created_at, updated_at)
      VALUES (?, 'taxc_standard', 'txreg_bd', ?, 1500, 0, 0, 1, 1, 1, 1)
    `);
    for (const id of rateIds) insertRate.run(id, id);
  }

  it("rolls back the actual post-state mutation that would remove final coverage", async () => {
    const db = createDatabase();
    seedEnabledTax(["taxr_last"]);

    await expect(updateTaxRate(db, "taxr_last", {
      expectedVersion: 1,
      isActive: false,
    })).rejects.toBeInstanceOf(ConflictError);

    expect(sqlite!.prepare(`
      SELECT is_active AS isActive, version
      FROM tax_rates WHERE id = 'taxr_last'
    `).get()).toEqual({ isActive: 1, version: 1 });
  });

  it("serializes concurrent removals and rejects a stale final-rate delete", async () => {
    const db = createDatabase();
    seedEnabledTax(["taxr_a", "taxr_b"]);

    const outcomes = await Promise.allSettled([
      updateTaxRate(db, "taxr_a", { expectedVersion: 1, isActive: false }),
      updateTaxRate(db, "taxr_b", { expectedVersion: 1, isActive: false }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
    const activeRate = sqlite!.prepare(`
      SELECT id, version FROM tax_rates
      WHERE is_active = 1
    `).get() as { id: string; version: number };
    expect(sqlite!.prepare(`
      SELECT count(*) AS count FROM tax_rates
      WHERE is_active = 1
    `).get()).toEqual({ count: 1 });

    const changed = await updateTaxRate(db, activeRate.id, {
      expectedVersion: activeRate.version,
      rateBps: 1_600,
    });
    await expect(deleteTaxRate(db, activeRate.id, activeRate.version))
      .rejects.toBeInstanceOf(ConflictError);

    expect(sqlite!.prepare(`
      SELECT is_active AS isActive, version
      FROM tax_rates WHERE id = ?
    `).get(activeRate.id)).toEqual({
      isActive: 1,
      version: changed.version,
    });
  });

  it("adds a country, its admin areas, postal prefixes and Bangladesh places, and refuses an orphan or a duplicate", async () => {
    const db = createDatabase();
    sqlite!.exec(`
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata)
        VALUES ('city_dhaka', 'Dhaka', 'city', NULL, '{}', '{}');
    `);
    await expect(createTaxRegion(db, { countryCode: "US", adminArea: "California" }))
      .rejects.toThrow("Add the country before its regions.");
    const us = await createTaxRegion(db, { countryCode: "us" });
    const california = await createTaxRegion(db, { countryCode: "US", adminArea: "California" });
    const sf = await createTaxRegion(db, { countryCode: "US", postalPrefix: "941 07" });
    expect([us.kind, california.kind, california.adminArea, sf.kind, sf.postalPrefix]).toEqual(["country", "admin_area", "CA", "postal_prefix", "94107"]);
    await expect(createTaxRegion(db, { countryCode: "US", adminArea: "CA" })).rejects.toBeInstanceOf(ConflictError);
    await expect(createTaxRegion(db, { countryCode: "US", adminArea: "Atlantis" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTaxRegion(db, { countryCode: "US", adminArea: "CA", providerId: "acme.tax:avalara" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTaxRegion(db, { countryCode: "BD", postalPrefix: "1205" })).rejects.toBeInstanceOf(ValidationError);
    await createTaxRegion(db, { countryCode: "BD" });
    const dhaka = await createTaxRegion(db, { countryCode: "BD", placeId: "city_dhaka" });
    expect(dhaka).toMatchObject({ kind: "place", placeType: "city", placeName: "Dhaka" });
    const updated = await updateTaxRegion(db, us.id, { expectedVersion: us.version, providerId: "acme.tax:avalara" });
    expect(updated.providerId).toBe("acme.tax:avalara");
    await expect(updateTaxRegion(db, us.id, { expectedVersion: us.version, providerId: null })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateTaxRegion(db, us.id, { expectedVersion: updated.version, providerId: "avalara" })).rejects.toBeInstanceOf(ValidationError);
    expect((await listTaxRegions(db, { countryCode: "US" })).map((region) => region.kind)).toEqual(["country", "admin_area", "postal_prefix"]);
  });

  it("removes a country with its regions and rates, unless tax would be left without a rate", async () => {
    const db = createDatabase();
    seedEnabledTax([]);
    const us = await createTaxRegion(db, { countryCode: "US" });
    const ca = await createTaxRegion(db, { countryCode: "US", adminArea: "CA" });
    await createTaxRate(db, { taxClassId: "taxc_standard", taxRegionId: ca.id, name: "California", rateBps: 725, combinable: true });
    // The only active rate of the default class: tax is on, so its region can't go.
    await expect(deleteTaxRegion(db, us.id, us.version)).rejects.toBeInstanceOf(ConflictError);
    expect((await getTaxRegion(db, us.id)).rates).toHaveLength(1);
    await createTaxRate(db, { taxClassId: "taxc_standard", taxRegionId: "txreg_bd", name: "VAT", rateBps: 1_500 });
    const detail = await getTaxRegion(db, us.id);
    expect(detail.subRegions.map((region) => region.id)).toEqual([ca.id]);
    await deleteTaxRegion(db, us.id, us.version);
    expect(sqlite!.prepare("SELECT country_code FROM tax_regions ORDER BY country_code").all()).toEqual([{ country_code: "BD" }]);
    expect(sqlite!.prepare("SELECT name FROM tax_rates").all()).toEqual([{ name: "VAT" }]);
  });

  it("keeps the store-wide provider unless the save names one, and lets an app provider tax without local rates", async () => {
    const db = createDatabase();
    sqlite!.exec(`
      INSERT INTO tax_classes (id, name) VALUES ('taxc_standard', 'Standard');
      INSERT INTO tax_settings (id, enabled, default_tax_class_id, display_label, version) VALUES ('default', 0, 'taxc_standard', 'Tax', 1);
    `);
    const base = { enabled: true, taxShipping: false, defaultTaxClassId: "taxc_standard", shippingTaxClassId: null, displayLabel: "Tax" };
    await expect(updateTaxSettings(db, { ...base, expectedVersion: 1, providerId: "system" })).rejects.toBeInstanceOf(ValidationError);
    // Without a provider the saved one (system) stays, and the database refuses taxing without a rate.
    await expect(updateTaxSettings(db, { ...base, expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError);
    const saved = await updateTaxSettings(db, { ...base, expectedVersion: 1, providerId: "acme.tax:avalara" });
    expect(saved).toMatchObject({ enabled: true, providerId: "acme.tax:avalara", version: 2 });
    const kept = await updateTaxSettings(db, { ...base, expectedVersion: 2, displayLabel: "Sales tax" });
    expect(kept).toMatchObject({ providerId: "acme.tax:avalara", displayLabel: "Sales tax" });
    await expect(updateTaxSettings(db, { ...base, expectedVersion: 3, providerId: "nope" })).rejects.toBeInstanceOf(ValidationError);
  });
});
