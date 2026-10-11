import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const CONVERSATION_INBOX_COUNTS_MIGRATION = "0141_conversation_inbox_counts";
const BREAKPOINT = "--> statement-breakpoint";
const incoming = (ref: string) => `${ref}.kind = 'message' AND ${ref}.visibility = 'public' AND ${ref}.author_type IN ('customer', 'guest_receipt')`;
const open = (ref: string) => `(${ref}.status = 'open' AND ${ref}.last_message_at IS NOT NULL)`;
const openCount = (ref: string) => `(CASE WHEN ${open(ref)} THEN 1 ELSE 0 END)`;
const unassignedCount = (ref: string) => `(CASE WHEN ${open(ref)} AND ${ref}.assignee_user_id IS NULL THEN 1 ELSE 0 END)`;

// External upgrades require the verified write freeze in upgrade-provider-schema.ts; this backfill is not an online migration.
export const conversationInboxCountsBackfill = [
  `INSERT INTO conversation_inbox_counts (scope, unread, open, unassigned_open)
SELECT '*',
  (SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.last_message_at IS NOT NULL AND m.seq > c.staff_read_seq AND ${incoming("m")}),
  coalesce(sum(${openCount("c")}), 0), coalesce(sum(${unassignedCount("c")}), 0)
FROM conversations c;`,
  `INSERT INTO conversation_inbox_counts (scope, open)
SELECT 'u:' || assignee_user_id, count(*) FROM conversations c
WHERE ${open("c")} AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id;`,
];

/** Run as one transaction with source authority stable; normal writes use only trigger deltas. */
export const conversationInboxCountsRebuild = ["DELETE FROM conversation_inbox_counts;", ...conversationInboxCountsBackfill];

export function generateConversationInboxCountsTriggers(): Array<{ name: string; sqlite: string }> {
  const triggers: Array<{ name: string; sqlite: string }> = [];
  const trigger = (suffix: string, event: string, table: string, guard: string, body: string) => {
    const name = `conversation_inbox_${suffix}`;
    triggers.push({ name, sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}\nWHEN ${guard}\nBEGIN\n  ${body};\nEND` });
  };
  trigger("incoming_insert", "INSERT", "conversation_messages",
    `${incoming("NEW")} AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = NEW.conversation_id AND c.last_message_at IS NOT NULL AND NEW.seq > c.staff_read_seq)`,
    "UPDATE conversation_inbox_counts SET unread = unread + 1 WHERE scope = '*'");
  // Public markers are monotonic. Keep raw, schema-valid marker corrections exact as well.
  for (const [suffix, relation, low, high, sign] of [
    ["read_advance", ">", "OLD.staff_read_seq", "NEW.staff_read_seq", "-"],
    ["read_retreat", "<", "NEW.staff_read_seq", "OLD.staff_read_seq", "+"],
  ] as const) {
    const where = `FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > ${low} AND m.seq <= ${high} AND ${incoming("m")}`;
    trigger(suffix, "UPDATE OF staff_read_seq", "conversations",
      `NEW.staff_read_seq ${relation} OLD.staff_read_seq AND OLD.last_message_at IS NOT NULL AND NEW.last_message_at IS NOT NULL AND EXISTS (SELECT 1 ${where})`,
      `UPDATE conversation_inbox_counts SET unread = unread ${sign} (SELECT count(*) ${where}) WHERE scope = '*'`);
  }
  // These transitions are disjoint from marker deltas, including simultaneous marker changes.
  for (const [suffix, oldNull, newNull, ref, sign] of [
    ["unread_activate", "NULL", "NOT NULL", "NEW", "+"],
    ["unread_deactivate", "NOT NULL", "NULL", "OLD", "-"],
  ] as const) {
    const where = `FROM conversation_messages m WHERE m.conversation_id = ${ref}.id AND m.seq > ${ref}.staff_read_seq AND ${incoming("m")}`;
    trigger(suffix, "UPDATE OF last_message_at", "conversations",
      `OLD.last_message_at IS ${oldNull} AND NEW.last_message_at IS ${newNull} AND EXISTS (SELECT 1 ${where})`,
      `UPDATE conversation_inbox_counts SET unread = unread ${sign} (SELECT count(*) ${where}) WHERE scope = '*'`);
  }
  trigger("open_insert", "INSERT", "conversations", open("NEW"),
    "UPDATE conversation_inbox_counts SET open = open + 1, unassigned_open = unassigned_open + (CASE WHEN NEW.assignee_user_id IS NULL THEN 1 ELSE 0 END) WHERE scope = '*'");
  const columns = "UPDATE OF status, last_message_at, assignee_user_id";
  trigger("open_update", columns, "conversations",
    `${openCount("NEW")} <> ${openCount("OLD")} OR ${unassignedCount("NEW")} <> ${unassignedCount("OLD")}`,
    `UPDATE conversation_inbox_counts SET open = open + ${openCount("NEW")} - ${openCount("OLD")}, unassigned_open = unassigned_open + ${unassignedCount("NEW")} - ${unassignedCount("OLD")} WHERE scope = '*'`);
  const enter = "INSERT INTO conversation_inbox_counts (scope, open) VALUES ('u:' || NEW.assignee_user_id, 1) ON CONFLICT (scope) DO UPDATE SET open = conversation_inbox_counts.open + 1";
  trigger("assignee_insert", "INSERT", "conversations", `${open("NEW")} AND NEW.assignee_user_id IS NOT NULL`, enter);
  trigger("assignee_leave", columns, "conversations",
    `${open("OLD")} AND OLD.assignee_user_id IS NOT NULL AND NOT (${open("NEW")} AND NEW.assignee_user_id IS OLD.assignee_user_id)`,
    "UPDATE conversation_inbox_counts SET open = open - 1 WHERE scope = 'u:' || OLD.assignee_user_id");
  trigger("assignee_enter", columns, "conversations",
    `${open("NEW")} AND NEW.assignee_user_id IS NOT NULL AND NOT (${open("OLD")} AND OLD.assignee_user_id IS NEW.assignee_user_id)`, enter);
  return triggers;
}

export function renderConversationInboxCountsMigration(ddl: readonly string[]) {
  const triggers = generateConversationInboxCountsTriggers();
  const body = [...ddl, ...conversationInboxCountsBackfill, ...triggers.map((t) => `${t.sqlite};`)];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (141, '${CONVERSATION_INBOX_COUNTS_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...[...ddl, ...conversationInboxCountsBackfill].map(compileSqliteDdlForPostgres),
      ...triggers.map((t) => compileSqliteTriggerForPostgres({ name: t.name, sql: t.sqlite })), ledger]
      .join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

// Drizzle creates the canonical table, journal and snapshot before this adds maintenance.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${CONVERSATION_INBOX_COUNTS_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s));
  if (ddl.length !== 1) throw new Error("Expected one Drizzle inbox count table.");
  const result = renderConversationInboxCountsMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${CONVERSATION_INBOX_COUNTS_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 140,\n {2}name: "0140_buyer_public_counts"/, `version: 141,\n  name: "${CONVERSATION_INBOX_COUNTS_MIGRATION}"`);
  const entry = `  {\n    version: 141,\n    name: "${CONVERSATION_INBOX_COUNTS_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 141,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 141,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${CONVERSATION_INBOX_COUNTS_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
