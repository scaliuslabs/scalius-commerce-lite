import { describe, expect, it, vi } from "vitest";
import { customerSessions, customers } from "@scalius/database/schema";

import {
  bulkDeleteCustomers,
  deleteCustomer,
  permanentlyDeleteCustomer,
} from "./customers.service";

const existingCustomer = {
  id: "cust_1",
  name: "Buyer",
  email: "buyer@example.com",
  phone: "+8801712345678",
  address: null,
  city: null,
  zone: null,
  area: null,
  cityName: null,
  zoneName: null,
  areaName: null,
};

function createDb(existing: unknown = existingCustomer) {
  const get = vi.fn(async () => existing);
  const selectWhere = vi.fn(() => ({ get }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const update = vi.fn((table: unknown) => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ op: "update", table })),
    })),
  }));
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn(() => ({ op: "insert", table })),
  }));
  const deleteFrom = vi.fn((table: unknown) => ({
    where: vi.fn(() => ({ op: "delete", table })),
  }));
  const batch = vi.fn(async (ops: unknown[]) => ops);

  return { select, update, insert, delete: deleteFrom, batch };
}

describe("customers service session revocation", () => {
  it("revokes active customer sessions when soft-deleting one customer", async () => {
    const db = createDb();

    await deleteCustomer(db as never, "cust_1");

    expect(db.update).toHaveBeenCalledWith(customers);
    expect(db.update).toHaveBeenCalledWith(customerSessions);
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ op: "update", table: customerSessions }),
    ]));
  });

  it("deletes customer session rows during permanent delete", async () => {
    const db = createDb();

    await permanentlyDeleteCustomer(db as never, "cust_1");

    expect(db.delete).toHaveBeenCalledWith(customerSessions);
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ op: "delete", table: customerSessions }),
    ]));
  });

  it("revokes or deletes session rows during bulk customer deletion", async () => {
    const softDb = createDb();
    await bulkDeleteCustomers(softDb as never, ["cust_1", "cust_2"], false);
    expect(softDb.update).toHaveBeenCalledWith(customerSessions);

    const permanentDb = createDb();
    await bulkDeleteCustomers(permanentDb as never, ["cust_1", "cust_2"], true);
    expect(permanentDb.delete).toHaveBeenCalledWith(customerSessions);
  });
});
