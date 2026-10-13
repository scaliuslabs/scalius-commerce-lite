// The `system_kv` behaviour every provider must share (D1 and PostgreSQL tests).
import { expect } from "vitest";
import type { Database } from "@scalius/database/client";

import {
  claimSystemKv,
  deleteSystemKv,
  getSystemKv,
  listSystemKv,
  purgeExpiredSystemKv,
  putSystemKv,
} from "../utils/system-kv";

export async function assertSystemKvContract(db: Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await putSystemKv(db, "oauth:grant:u1:g1", "{\"a\":1}");
  await putSystemKv(db, "oauth:grant:u1:g2", "two", now + 600);
  await putSystemKv(db, "oauth:grant:u1:g3", "gone", now - 1);
  await putSystemKv(db, "oauth:token:u1:g1:t1", "token");
  await putSystemKv(db, "oauth_other", "not a prefix match");

  expect(await getSystemKv(db, "oauth:grant:u1:g1")).toBe("{\"a\":1}");
  // An expired row reads as absent and is not listed.
  expect(await getSystemKv(db, "oauth:grant:u1:g3")).toBeNull();
  expect((await listSystemKv(db, "oauth:grant:")).keys).toEqual(["oauth:grant:u1:g1", "oauth:grant:u1:g2"]);

  // Pages walk in key order from the cursor.
  const first = await listSystemKv(db, "oauth:", { limit: 2 });
  expect(first).toEqual({ keys: ["oauth:grant:u1:g1", "oauth:grant:u1:g2"], cursor: "oauth:grant:u1:g2" });
  expect(await listSystemKv(db, "oauth:", { limit: 2, cursor: first.cursor! }))
    .toEqual({ keys: ["oauth:token:u1:g1:t1"], cursor: null });

  // An upsert replaces value and expiry.
  await putSystemKv(db, "oauth:grant:u1:g2", "updated");
  expect(await getSystemKv(db, "oauth:grant:u1:g2")).toBe("updated");

  // A claim wins once per value; an expired row is claimable again.
  expect(await claimSystemKv(db, "marker", "v1")).toBe(true);
  expect(await claimSystemKv(db, "marker", "v1")).toBe(false);
  expect(await claimSystemKv(db, "marker", "v2")).toBe(true);
  expect(await claimSystemKv(db, "oauth:grant:u1:g3", "gone")).toBe(true);
  await putSystemKv(db, "oauth:grant:u1:g3", "gone", now - 1);

  await deleteSystemKv(db, "oauth:token:u1:g1:t1");
  expect(await getSystemKv(db, "oauth:token:u1:g1:t1")).toBeNull();

  expect(await purgeExpiredSystemKv(db)).toBe(1);
  expect(await purgeExpiredSystemKv(db)).toBe(0);
  expect((await listSystemKv(db, "")).keys.sort()).toEqual(["marker", "oauth:grant:u1:g1", "oauth:grant:u1:g2", "oauth_other"]);
}
