import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { SCANNER_SESSION_TTL_SECONDS } from "@scalius/shared/scanner-auth";

import {
  cleanupExpiredScannerTokenClaims,
  consumeScannerTokenClaim,
  createScannerTokenClaim,
  readScannerSession,
} from "./scanner-token-claims";

describe("scanner sessions in the relational database", () => {
  async function paired() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec("INSERT INTO user (id, name, email, email_verified, role) VALUES ('admin_1', 'Admin', 'admin@shop.test', 1, 'admin')");
    await createScannerTokenClaim(harness.db, { token: "sct_token", adminId: "admin_1", adminName: "Warehouse", nowMs: 1_000_000 });
    await consumeScannerTokenClaim(harness.db, { token: "sct_token", sessionId: "session-secret", nowMs: 1_000_000 });
    return harness;
  }

  it("reads the live session by its cookie value and slides it on refresh", async () => {
    const { db, sqlite } = await paired();

    expect(await readScannerSession(db, "session-secret", { nowMs: 1_000_000 })).toEqual({ adminId: "admin_1", adminName: "Warehouse" });
    expect(await readScannerSession(db, "other-session", { nowMs: 1_000_000 })).toBeNull();
    // The raw cookie value is never stored.
    expect(JSON.stringify(sqlite.prepare("SELECT * FROM scanner_token_claims").all())).not.toContain("session-secret");

    const nearEnd = (1_000 + SCANNER_SESSION_TTL_SECONDS - 1) * 1000;
    expect(await readScannerSession(db, "session-secret", { nowMs: nearEnd, refresh: true })).not.toBeNull();
    // The refresh slid the session: it outlives its first lifetime.
    expect(await readScannerSession(db, "session-secret", { nowMs: nearEnd + 60_000 })).not.toBeNull();
    expect(await readScannerSession(db, "session-secret", { nowMs: nearEnd + SCANNER_SESSION_TTL_SECONDS * 1000 })).toBeNull();
  });

  it("ends with its admin and is swept once expired", async () => {
    const live = await paired();
    live.sqlite.exec("DELETE FROM user WHERE id = 'admin_1'");
    expect(await readScannerSession(live.db, "session-secret", { nowMs: 1_000_000 })).toBeNull();

    const { db, sqlite } = await paired();
    expect((await cleanupExpiredScannerTokenClaims(db, { nowSeconds: 1_000 + 60 })).deleted).toBe(0);
    expect((await cleanupExpiredScannerTokenClaims(db, { nowSeconds: 1_000 + SCANNER_SESSION_TTL_SECONDS })).deleted).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scanner_token_claims").get()).toEqual({ count: 0 });
  });
});
