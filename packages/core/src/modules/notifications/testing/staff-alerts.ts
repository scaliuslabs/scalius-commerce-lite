import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

export async function seedStaffAlerts(db: Database) {
  await db.run(sql`INSERT INTO "user" (id,name,email) VALUES ('bell_a','Staff A','a@example.test'),('bell_b','Staff B','b@example.test')`);
  await db.run(sql`INSERT INTO permissions (id,name,display_name,resource,action,category) VALUES
    ('bell_orders','orders.view','Orders','orders','view','Orders'),
    ('bell_conversations','conversations.view','Inbox','conversations','view','Inbox')`);
  await db.run(sql`INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES
    ('bell_a_orders','bell_a','bell_orders',1),('bell_a_conversations','bell_a','bell_conversations',1),
    ('bell_b_orders','bell_b','bell_orders',1)`);
  await db.run(sql`INSERT INTO orders (id,order_number,customer_name,customer_phone,shipping_address,city,zone)
    VALUES ('bell_order',1234,'Private Buyer','+8801711111111','Private address','city','zone')`);
  await db.run(sql`INSERT INTO conversations (id,subject_type,order_id) VALUES ('cnv_bell_00001','order','bell_order')`);
}
export async function seedStaffAlertEvent(db: Database, id: string, conversation = false, createdAt = 1000) {
  await db.run(sql`INSERT INTO notification_outbox
    (id,dedupe_key,subject_type,subject_id,order_id,conversation_id,audience,notification_type,source,payload,created_at)
    VALUES (${id},${id},${conversation ? "conversation" : "order"},${conversation ? "cnv_bell_00001" : "bell_order"},
      ${conversation ? null : "bell_order"},${conversation ? "cnv_bell_00001" : null},'staff',
      ${conversation ? "conversation_message" : "order_created"},'test','{}',${createdAt})`);
}
