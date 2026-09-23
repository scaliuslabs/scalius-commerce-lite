import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { saveSettingAggregate } from "./settings-write";

const KEY = Buffer.alloc(32, 3).toString("base64");

function setup() {
  const harness = createSqliteD1Database();
  const rows = () => harness.sqlite.prepare("SELECT key, value FROM settings ORDER BY key").all() as
    Array<{ key: string; value: string }>;
  return { ...harness, rows };
}

describe("saveSettingAggregate", () => {
  it("encrypts secrets with the credential key and writes the aggregate together", async () => {
    const { db, rows } = setup();

    await saveSettingAggregate(db, [
      { category: "stripe", key: "publishable_key", value: "pk_test_value" },
      { category: "stripe", key: "secret_key", value: "sk_test_value", encrypted: true },
      { category: "stripe", key: "enabled", value: "true" },
    ], KEY);

    const saved = Object.fromEntries(rows().map((row) => [row.key, row.value]));
    expect(saved).toMatchObject({ publishable_key: "pk_test_value", enabled: "true" });
    expect(saved.secret_key).toMatch(/^enc:/);
    expect(JSON.stringify(rows())).not.toContain("sk_test_value");
    await expect(readStoredCredentialStrict(saved.secret_key, KEY)).resolves.toMatchObject({ value: "sk_test_value" });
  });

  it("fails without writing anything when encryption authority is missing", async () => {
    const { db, rows } = setup();

    await expect(saveSettingAggregate(db, [
      { category: "stripe", key: "enabled", value: "true" },
      { category: "stripe", key: "secret_key", value: "secret", encrypted: true },
    ])).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY");
    expect(rows()).toEqual([]);
  });

  it("rejects duplicate keys instead of relying on statement ordering", async () => {
    const { db, rows } = setup();

    await expect(saveSettingAggregate(db, [
      { category: "email", key: "provider", value: "resend" },
      { category: "email", key: "provider", value: "cloudflare" },
    ])).rejects.toThrow("Duplicate setting write");
    expect(rows()).toEqual([]);
  });
});
