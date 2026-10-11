// Independent source oracle; do not derive expected values from the maintenance generator.
export const inboxCountsActual = `SELECT scope,unread,open,unassigned_open FROM conversation_inbox_counts
WHERE scope='*' OR open>0 ORDER BY scope`;
export const inboxCountsOracle = `SELECT '*' AS scope,
  (SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.last_message_at IS NOT NULL AND m.seq>c.staff_read_seq
      AND m.kind='message' AND m.visibility='public' AND m.author_type IN ('customer','guest_receipt')) AS unread,
  (SELECT count(*) FROM conversations WHERE status='open' AND last_message_at IS NOT NULL) AS open,
  (SELECT count(*) FROM conversations WHERE status='open' AND last_message_at IS NOT NULL AND assignee_user_id IS NULL) AS unassigned_open
UNION ALL SELECT 'u:'||assignee_user_id,0,count(*),0 FROM conversations
  WHERE status='open' AND last_message_at IS NOT NULL AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id ORDER BY scope`;
export const inboxCountsSeed = [
  "INSERT INTO customers(id,name,phone,origin) VALUES ('acct_count','Buyer','+8801711111111','account')",
  "INSERT INTO \"user\"(id,name,email,email_verified,role) VALUES ('staff_count_a','A','a@counts.test',1,'admin'),('staff_count_b','B','b@counts.test',1,'admin')",
  "INSERT INTO conversations(id,subject_type,customer_id,status,closed_at) VALUES ('cnv_count_0001','store','acct_count','open',NULL),('cnv_count_0002','store','acct_count','pending',NULL),('cnv_count_0003','store','acct_count','closed',1)",
];
export function inboxAppend(id: string, seq: number, kind: "guest" | "customer" | "staff" | "note" | "event" = "guest") {
  const author = kind === "guest" ? "guest_receipt" : kind === "event" ? "system" : kind === "note" ? "staff" : kind;
  return [
    `UPDATE conversations SET last_seq=${seq},last_message_at=100,last_author_type='${author}' WHERE id='${id}' AND last_seq=${seq - 1}`,
    `INSERT INTO conversation_messages(id,conversation_id,seq,kind,visibility,author_type,author_customer_id,author_user_id,body,event_kind)
      VALUES ('msg_${id}_${seq}','${id}',${seq},'${kind === "event" ? "event" : "message"}','${kind === "note" ? "internal" : "public"}','${author}',
      ${kind === "customer" ? "'acct_count'" : "NULL"},${author === "staff" ? "'staff_count_a'" : "NULL"},${kind === "event" ? "NULL,'changed'" : "'Message',NULL"})`,
  ];
}
export const inboxCountsHistory = ["cnv_count_0001", "cnv_count_0002", "cnv_count_0003"].flatMap((id) =>
  (["guest", "staff", "note", "event", "customer", "guest"] as const).flatMap((kind, index) => inboxAppend(id, index + 1, kind)));
export const inboxCountsMutations = [
  "UPDATE conversations SET assignee_user_id='staff_count_a' WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=2 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=4 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=staff_read_seq WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=1 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET last_message_at=NULL,staff_read_seq=5 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET last_message_at=101,staff_read_seq=1 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET last_message_at=NULL WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=6 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET last_message_at=102 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET staff_read_seq=0 WHERE id='cnv_count_0001'",
  "UPDATE conversations SET status='open',closed_at=NULL,assignee_user_id='staff_count_a' WHERE id='cnv_count_0003'",
  "UPDATE conversations SET status='open',assignee_user_id='staff_count_b' WHERE id='cnv_count_0002'",
  "UPDATE conversations SET assignee_user_id='staff_count_b' WHERE id='cnv_count_0001'",
  "UPDATE conversations SET status='closed',closed_at=103 WHERE id='cnv_count_0003'",
  "UPDATE conversations SET status='pending' WHERE id='cnv_count_0002'",
  "DELETE FROM \"user\" WHERE id='staff_count_b'",
  "UPDATE conversations SET last_message_at=NULL",
];
