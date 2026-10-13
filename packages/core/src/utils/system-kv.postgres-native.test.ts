// PostgreSQL parity for `system_kv`. Opt-in: point SCALIUS_TEST_POSTGRES_URL
// at a disposable server; the test creates and drops its own database.
import { afterAll, describe, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";

import { assertSystemKvContract } from "../testing/system-kv-contract";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("system_kv on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("reads live rows, lists by prefix in pages, claims once and purges expired rows", async () => {
    const { db } = await createNativePostgres({ label: "system_kv" });
    await assertSystemKvContract(db);
  });
});
