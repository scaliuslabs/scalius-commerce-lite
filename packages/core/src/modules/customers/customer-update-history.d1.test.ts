import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { customerHistory } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { createCustomer, updateCustomer } from "./customers.service";

describe("customer change history", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => sqlite.close());

  const entries = (customerId: string) =>
    db.select({ changeType: customerHistory.changeType, name: customerHistory.name })
      .from(customerHistory)
      .where(eq(customerHistory.customerId, customerId));

  it("records a change only when a field actually changed", async () => {
    const { id } = await createCustomer(db, { name: "Karim", phone: "+8801712345678", email: null, address: "Mirpur", city: null, zone: null, area: null });

    // Saving the same values again (the dashboard sends the whole form) adds nothing.
    await updateCustomer(db, id, { name: "Karim", phone: "+8801712345678", email: null, address: "Mirpur" });
    expect(await entries(id)).toEqual([{ changeType: "created", name: "Karim" }]);

    await updateCustomer(db, id, { name: "Karim Uddin", address: "Mirpur" });
    expect((await entries(id)).map((entry) => entry.changeType)).toEqual(["created", "updated"]);
    expect((await entries(id))[1]).toEqual({ changeType: "updated", name: "Karim Uddin" });
  });
});
