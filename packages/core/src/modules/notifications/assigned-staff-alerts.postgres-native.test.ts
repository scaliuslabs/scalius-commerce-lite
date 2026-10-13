import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { recordStaffAlert } from "./staff-alerts";
import { seedStaffAlertEvent } from "./testing/staff-alerts";
import { seedAssignedStaffAlerts, staffAlertRecipients } from "./testing/assigned-staff-alerts";

afterAll(closeNativePostgres);
describe.runIf(nativePostgresUrl())("assigned conversation alerts on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("uses current eligible assignment only on the first transactional fanout", async () => {
    const { db } = await createNativePostgres({ label: "assigned_alerts" });
    await seedAssignedStaffAlerts(db);
    await seedStaffAlertEvent(db, "assigned_first", true);
    await recordStaffAlert(db, "assigned_first", true);
    expect(await staffAlertRecipients(db, "assigned_first")).toEqual(["bell_a"]);
    await db.run(sql`UPDATE conversations SET assignee_user_id='bell_b' WHERE id='cnv_bell_00001'`);
    await recordStaffAlert(db, "assigned_first", true);
    expect(await staffAlertRecipients(db, "assigned_first")).toEqual(["bell_a"]);
    await db.run(sql`UPDATE user_permissions SET granted=0 WHERE id='bell_b_reply'`);
    await seedStaffAlertEvent(db, "assigned_fallback", true);
    await recordStaffAlert(db, "assigned_fallback", true);
    expect(await staffAlertRecipients(db, "assigned_fallback")).toEqual(["bell_a", "bell_b"]);
    await db.run(sql`UPDATE "user" SET banned=1 WHERE id='bell_b'`);
    await seedStaffAlertEvent(db, "assigned_banned", true);
    await recordStaffAlert(db, "assigned_banned", true);
    expect(await staffAlertRecipients(db, "assigned_banned")).toEqual(["bell_a"]);
  });
});
