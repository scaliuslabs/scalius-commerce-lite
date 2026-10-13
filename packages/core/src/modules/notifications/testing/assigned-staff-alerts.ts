import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { seedStaffAlerts } from "./staff-alerts";

export async function seedAssignedStaffAlerts(db: Database) {
  await seedStaffAlerts(db);
  await db.run(sql`INSERT INTO permissions (id,name,display_name,resource,action,category)
    VALUES ('bell_reply','conversations.reply','Reply','conversations','reply','Inbox')`);
  await db.run(sql`INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES
    ('bell_a_reply','bell_a','bell_reply',1),('bell_b_reply','bell_b','bell_reply',1),
    ('bell_b_conversations','bell_b','bell_conversations',1)`);
  await db.run(sql`UPDATE conversations SET assignee_user_id='bell_a' WHERE id='cnv_bell_00001'`);
}

export async function staffAlertRecipients(db: Database, alertId: string) {
  return (await db.all<{ user_id: string }>(sql`SELECT user_id FROM staff_alert_inbox
    WHERE alert_id=${alertId} ORDER BY user_id`)).map((row) => row.user_id);
}
