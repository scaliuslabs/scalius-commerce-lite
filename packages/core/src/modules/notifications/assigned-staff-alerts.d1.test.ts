import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { recordStaffAlert } from "./staff-alerts";
import { sendAdminPush } from "./notifications.service";
import { savePushSubscription } from "./web-push";
import { seedStaffAlertEvent } from "./testing/staff-alerts";
import { seedAssignedStaffAlerts, staffAlertRecipients } from "./testing/assigned-staff-alerts";

const fcm = vi.hoisted(() => ({ sendEachForMulticast: vi.fn() }));
vi.mock("../../integrations/firebase/admin", () => ({ getFirebaseAdminMessaging: () => fcm }));
const ENV = { SCALIUS_SECRET: "assigned-alert-test-master-secret-0123456789abcdef", BETTER_AUTH_URL: "https://admin.example.test" } as unknown as Env;

describe.each(["d1", "turso"] as const)("assigned conversation alerts (%s)", (provider) => {
  let db: Database;
  let sqlite: DatabaseSync;
  let queries: Array<{ text: string; params: SQLInputValue[] }>;
  beforeEach(async () => {
    queries = [];
    ({ db, sqlite } = createSqliteD1Database({ provider, onQuery: (text, params) => queries.push({ text, params: params as SQLInputValue[] }) }));
    await seedAssignedStaffAlerts(db);
    fcm.sendEachForMulticast.mockReset().mockImplementation(async ({ tokens }: { tokens: string[] }) => ({
      failureCount: 0, responses: tokens.map(() => ({ success: true, messageId: "accepted" })),
    }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { sqlite.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("fixes the first assignee, follows reassignment only for new messages, and leaves orders broadcast", async () => {
    await seedStaffAlertEvent(db, "assigned_first", true);
    await recordStaffAlert(db, "assigned_first", true);
    expect(await staffAlertRecipients(db, "assigned_first")).toEqual(["bell_a"]);
    await db.run(sql`UPDATE conversations SET assignee_user_id='bell_b' WHERE id='cnv_bell_00001'`);
    await recordStaffAlert(db, "assigned_first", true);
    expect(await staffAlertRecipients(db, "assigned_first")).toEqual(["bell_a"]);
    await seedStaffAlertEvent(db, "assigned_next", true);
    await recordStaffAlert(db, "assigned_next", true);
    expect(await staffAlertRecipients(db, "assigned_next")).toEqual(["bell_b"]);
    await seedStaffAlertEvent(db, "assigned_order");
    await recordStaffAlert(db, "assigned_order", true);
    expect(await staffAlertRecipients(db, "assigned_order")).toEqual(["bell_a", "bell_b"]);
  });

  it.each([
    ["unassigned", "UPDATE conversations SET assignee_user_id=NULL", ["bell_a", "bell_b"]],
    ["reply revoked", "UPDATE user_permissions SET granted=0 WHERE id='bell_a_reply'", ["bell_a", "bell_b"]],
    ["banned", "UPDATE user SET banned=1 WHERE id='bell_a'", ["bell_b"]],
    ["view denied", "UPDATE user_permissions SET granted=0 WHERE id='bell_a_conversations'", ["bell_b"]],
  ])("falls back to the current authorized team when the assignee is %s", async (_label, mutation, expected) => {
    sqlite.exec(mutation as string);
    await seedStaffAlertEvent(db, "assigned_fallback", true);
    await recordStaffAlert(db, "assigned_fallback", true);
    expect(await staffAlertRecipients(db, "assigned_fallback")).toEqual(expected);
  });

  it("keeps a completed empty fanout empty after permissions return", async () => {
    await db.run(sql`UPDATE user_permissions SET granted=0 WHERE permission_id='bell_conversations'`);
    await seedStaffAlertEvent(db, "assigned_empty", true);
    await recordStaffAlert(db, "assigned_empty", true);
    await db.run(sql`UPDATE user_permissions SET granted=1 WHERE permission_id='bell_conversations'`);
    await recordStaffAlert(db, "assigned_empty", true);
    expect(await staffAlertRecipients(db, "assigned_empty")).toEqual([]);
  });

  async function subscribeTeam() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const keys = {
      p256dh: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    };
    for (const userId of ["bell_a", "bell_b"]) {
      await savePushSubscription(db, { audience: "staff", userId }, { endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`, keys });
      await db.run(sql`INSERT INTO admin_fcm_tokens (id,user_id,token,is_active) VALUES (${userId},${userId},${`token_${userId}`},1)`);
    }
  }
  const spec = (outboxId: string) => ({
    outboxId, receipt: { subjectType: "conversation" as const, subjectId: "cnv_bell_00001", notificationType: "conversation_message" as const },
    setupRecipient: "assigned-test", logLabel: "assigned-test", title: "Message", body: "Open inbox", link: null, data: {},
  });

  it("retries both transports only for the original recipient after reassignment", async () => {
    await subscribeTeam();
    await seedStaffAlertEvent(db, "assigned_retry", true);
    const delivered: string[] = [];
    const send = vi.fn(async (url: string) => { delivered.push(url); return new Response(null, { status: 503 }); });
    vi.stubGlobal("fetch", send);
    fcm.sendEachForMulticast.mockRejectedValueOnce(new Error("temporary transport failure"));
    expect((await sendAdminPush(db, ENV, spec("assigned_retry"))).hasRetryableFailure).toBe(true);
    expect(fcm.sendEachForMulticast).toHaveBeenLastCalledWith(expect.objectContaining({ tokens: ["token_bell_a"] }));
    expect(delivered).toEqual(["https://fcm.googleapis.com/fcm/send/bell_a"]);
    for (const [table, index] of [["push_subscriptions", "push_subscriptions_staff_idx"], ["admin_fcm_tokens", "admin_fcm_tokens_user_id_idx"]]) {
      const query = queries.find(({ text }) => text.includes(`from "${table}"`) && text.includes("SELECT user_id FROM staff_alert_inbox"))!;
      expect(query).toBeDefined();
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.text}`).all(...query.params).map((row) => String(row.detail)).join("\n");
      expect(plan).toContain(index);
      expect(plan).toContain("staff_alert_inbox_event_user_idx");
      expect(plan).toMatch(/user_id=\?/);
      expect(plan).not.toContain(`SCAN ${table}`);
    }
    await db.run(sql`UPDATE conversations SET assignee_user_id='bell_b' WHERE id='cnv_bell_00001'`);
    await db.run(sql`UPDATE notification_delivery_receipts SET next_attempt_at=0 WHERE status='failed'`);
    send.mockImplementation(async (url: string) => { delivered.push(url); return new Response(null, { status: 201 }); });
    expect((await sendAdminPush(db, ENV, spec("assigned_retry"))).hasRetryableFailure).toBe(false);
    expect(fcm.sendEachForMulticast).toHaveBeenLastCalledWith(expect.objectContaining({ tokens: ["token_bell_a"] }));
    expect(delivered).toEqual(Array(2).fill("https://fcm.googleapis.com/fcm/send/bell_a"));
    expect(await staffAlertRecipients(db, "assigned_retry")).toEqual(["bell_a"]);
  });

  it("does not redirect a frozen alert when the original recipient loses access", async () => {
    await subscribeTeam();
    await seedStaffAlertEvent(db, "assigned_revoked", true);
    await recordStaffAlert(db, "assigned_revoked", true);
    await db.run(sql`UPDATE conversations SET assignee_user_id='bell_b' WHERE id='cnv_bell_00001'`);
    await db.run(sql`UPDATE user_permissions SET granted=0 WHERE id='bell_a_conversations'`);
    const send = vi.fn(); vi.stubGlobal("fetch", send);
    expect((await sendAdminPush(db, ENV, spec("assigned_revoked"))).outcomes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(fcm.sendEachForMulticast).not.toHaveBeenCalled();
    expect(await staffAlertRecipients(db, "assigned_revoked")).toEqual(["bell_a"]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_delivery_receipts").get()).toEqual({ n: 0 });
  });
});
