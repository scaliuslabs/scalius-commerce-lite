import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { createTaxClass, createTaxRate, updateTaxClass } from "./tax-admin.service";

function createRateDb(location: { id: string; name: string } | null) {
  const getResults = [{ id: "taxc_standard" }, location];
  const select = vi.fn(() => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      get: vi.fn(async () => getResults.shift() ?? null),
    };
    return query;
  });
  const returning = vi.fn(async () => [{
    id: "taxr_1",
    taxClassId: "taxc_standard",
    name: "Dhaka rate",
    rateBps: 500,
    jurisdictionType: "city",
    jurisdictionId: "city_1",
    jurisdictionLabel: "Dhaka",
    priority: 0,
    isCompound: false,
    isActive: true,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { db: { select, insert }, insert, values };
}

describe("tax Admin jurisdiction authority", () => {
  it("persists the authoritative D1 location label instead of client text", async () => {
    const { db, values } = createRateDb({ id: "city_1", name: "Dhaka" });

    await createTaxRate(db as never, {
      taxClassId: "taxc_standard",
      name: "Dhaka rate",
      rateBps: 500,
      jurisdictionType: "city",
      jurisdictionId: "city_1",
      jurisdictionLabel: "Untrusted client label",
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      jurisdictionType: "city",
      jurisdictionId: "city_1",
      jurisdictionLabel: "Dhaka",
    }));
  });

  it("rejects missing, inactive, or wrong-type location identifiers", async () => {
    const { db, insert } = createRateDb(null);

    await expect(createTaxRate(db as never, {
      taxClassId: "taxc_standard",
      name: "Invalid scope",
      rateBps: 500,
      jurisdictionType: "zone",
      jurisdictionId: "city_1",
    })).rejects.toBeInstanceOf(ValidationError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("preserves omitted class fields during a versioned rename", async () => {
    const current = {
      id: "taxc_standard",
      name: "Standard",
      description: "Saved description",
      isExempt: true,
      version: 4,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
    };
    const getResults = [current, null];
    const select = vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        get: vi.fn(async () => getResults.shift() ?? null),
      };
      return query;
    });
    const returning = vi.fn(async () => [{ ...current, name: "Renamed", version: 5 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    await updateTaxClass({ select, update } as never, "taxc_standard", {
      expectedVersion: 4,
      name: "Renamed",
    });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      name: "Renamed",
      description: "Saved description",
      isExempt: true,
    }));
  });

  it("maps a concurrent case-insensitive active-name race to a conflict", async () => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      get: vi.fn(async () => null),
    };
    const db = {
      select: vi.fn(() => query),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            throw new Error("UNIQUE constraint failed: index 'tax_classes_active_name_ci_unique'");
          }),
        })),
      })),
    };

    await expect(createTaxClass(db as never, { name: "vat" }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
