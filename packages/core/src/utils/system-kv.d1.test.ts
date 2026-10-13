import { describe, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { assertSystemKvContract } from "../testing/system-kv-contract";

describe("system_kv on D1", () => {
  it("reads live rows, lists by prefix in pages, claims once and purges expired rows", async () => {
    await assertSystemKvContract(createSqliteD1Database().db);
  });
});
