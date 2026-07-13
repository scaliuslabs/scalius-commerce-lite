import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { products } from "@scalius/database/schema";
import {
  createTaxClass,
  createTaxRate,
  updateTaxClass,
  updateTaxClassification,
  updateTaxSettings,
} from "./tax-admin.service";

const taxSettingsInput = {
  expectedVersion: 1,
  enabled: true,
  pricesIncludeTax: false,
  taxShipping: false,
  defaultTaxClassId: "taxc_standard",
  shippingTaxClassId: null,
  displayLabel: "Tax",
};

function createSettingsDb(getResults: unknown[]) {
  const results = [...getResults];
  const select = vi.fn(() => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      get: vi.fn(async () => results.shift() ?? null),
    };
    return query;
  });
  const returning = vi.fn(async () => [{
    id: "default",
    ...taxSettingsInput,
    version: 2,
  }]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { select, update }, select, update };
}

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
  it("rejects activation when the taxable default class has no active rate", async () => {
    const { db, update } = createSettingsDb([
      { id: "taxc_standard", name: "Standard", isExempt: false },
      null,
    ]);

    await expect(updateTaxSettings(db as never, taxSettingsInput))
      .rejects.toThrow("Add an active rate to default product class “Standard”");
    expect(update).not.toHaveBeenCalled();
  });

  it("checks a separate effective shipping class before activation", async () => {
    const { db, update } = createSettingsDb([
      { id: "taxc_standard", name: "Standard", isExempt: false },
      { id: "taxc_shipping", name: "Shipping", isExempt: false },
      { id: "taxr_standard" },
      null,
    ]);

    await expect(updateTaxSettings(db as never, {
      ...taxSettingsInput,
      taxShipping: true,
      shippingTaxClassId: "taxc_shipping",
    })).rejects.toThrow("Add an active rate to shipping class “Shipping”");
    expect(update).not.toHaveBeenCalled();
  });

  it("allows an incomplete legacy setup to be disabled for repair", async () => {
    const { db, select, update } = createSettingsDb([
      { id: "taxc_standard", name: "Standard", isExempt: false },
    ]);

    await expect(updateTaxSettings(db as never, {
      ...taxSettingsInput,
      enabled: false,
    })).resolves.toMatchObject({ version: 2 });
    expect(select).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("allows activation after the taxable default class has an active rate", async () => {
    const { db, select, update } = createSettingsDb([
      { id: "taxc_standard", name: "Standard", isExempt: false },
      { id: "taxr_standard" },
    ]);

    await expect(updateTaxSettings(db as never, taxSettingsInput))
      .resolves.toMatchObject({ version: 2 });
    expect(select).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

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

  it("commits tax and product aggregate revisions in one guarded batch", async () => {
    const statements: Array<{ kind: string }> = [];
    let productUpdateCount = 0;
    const db = {
      select() {
        return {
          from() {
            return { kind: "guard" };
          },
        };
      },
      update(table: unknown) {
        expect(table).toBe(products);
        productUpdateCount += 1;
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return {
                      kind: productUpdateCount === 1 ? "classification" : "revision",
                    };
                  },
                };
              },
            };
          },
        };
      },
      async batch(batchStatements: Array<{ kind: string }>) {
        statements.push(...batchStatements);
        return batchStatements.map((statement) => {
          if (statement.kind === "classification") {
            return [{ id: "prod_1", taxClassId: null, version: 3 }];
          }
          if (statement.kind === "revision") return [{ aggregateRevision: 6 }];
          return [{ ok: 1 }];
        });
      },
    };

    const result = await updateTaxClassification(db as never, {
      kind: "product",
      id: "prod_1",
      taxClassId: null,
      expectedVersion: 2,
      expectedAggregateRevision: 5,
    });

    expect(statements.map((statement) => statement.kind)).toEqual([
      "guard",
      "guard",
      "classification",
      "revision",
    ]);
    expect(result).toMatchObject({ version: 3, aggregateRevision: 6 });
  });
});
