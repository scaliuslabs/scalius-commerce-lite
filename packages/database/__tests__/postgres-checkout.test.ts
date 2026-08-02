import { describe, expect, it } from "vitest";

import {
  POSTGRES_CHECKOUT_COMMIT_FUNCTION,
  buildPostgresCheckoutCommitFunctionSql,
} from "../src/postgres-checkout";

describe("PostgreSQL checkout function", () => {
  it("builds one deterministic server-side transaction from the canonical kernel", () => {
    const sql = buildPostgresCheckoutCommitFunctionSql();
    expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${POSTGRES_CHECKOUT_COMMIT_FUNCTION}`);
    expect(sql).toContain("INSERT INTO orders");
    expect(sql).toContain("UPDATE inventory_reservation_lanes AS lane");
    expect(sql).toContain("INSERT INTO checkout_batch_outbox");
    expect(sql).not.toContain("?1");
    expect(sql).not.toMatch(/\$\d+/);
  });
});
