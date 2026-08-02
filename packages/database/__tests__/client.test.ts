import { describe, expect, it, vi } from "vitest";
import { getDatabaseProviderForClient, getDb } from "../src/client";

function d1Binding() {
  return {
    prepare: vi.fn(),
  } as unknown as D1Database;
}

describe("database client composition", () => {
  it("does not leak the first D1 binding through isolate-global state", () => {
    const first = d1Binding();
    const second = d1Binding();

    const firstDb = getDb({ DB: first });
    const secondDb = getDb({ DB: second });

    expect(firstDb).not.toBe(secondDb);
    expect((firstDb as unknown as { $client: D1Database }).$client).toBe(first);
    expect((secondDb as unknown as { $client: D1Database }).$client).toBe(second);
    expect(getDatabaseProviderForClient(firstDb)).toBe("d1");
  });

  it("fails closed when no complete provider is configured", () => {
    expect(() => getDb()).toThrow(/D1 database binding/);
  });

  it("composes PostgreSQL from one connection-string secret", () => {
    const db = getDb({
      POSTGRES_DATABASE_URL: "postgresql://user:secret@example.neon.tech/merchant",
    });
    expect(getDatabaseProviderForClient(db)).toBe("postgres");
  });
});
