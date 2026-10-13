// Source definitions of two trigger-maintained projections, shared by their
// migrations (0139, 0141) and the drift check and repair that heal them.
// Pure SQL text: no bindings or database access.

const REAL_STATUSES = "('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')";
export const recommendationRealOrderSql = (alias: string) => `${alias}.status IN ${REAL_STATUSES} AND ${alias}.deleted_at IS NULL`;
export const recommendationBuyerSql = (alias: string) => `coalesce(nullif(${alias}.customer_phone, ''), lower(trim(${alias}.customer_email)))`;

export const recommendationOrderProductsBackfill = `INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
SELECT DISTINCT o.id, item.product_id, o.created_at, ${recommendationBuyerSql("o")}
FROM orders o JOIN order_items item ON item.order_id = o.id WHERE ${recommendationRealOrderSql("o")};`;

/** The pairs `recommendation_order_products` must hold for the orders `orderIds` selects. */
function recommendationPairs(orderIds: string): string {
  return `SELECT DISTINCT o.id AS order_id, item.product_id, o.created_at, ${recommendationBuyerSql("o")} AS buyer
    FROM orders o JOIN order_items item ON item.order_id = o.id
    WHERE o.id IN (${orderIds}) AND ${recommendationRealOrderSql("o")}`;
}

const symmetricDifference = (expected: string, stored: string) => `SELECT count(*) AS drift FROM (
    SELECT * FROM (${expected}) AS e1 EXCEPT SELECT * FROM (${stored}) AS s1
    UNION ALL SELECT * FROM (${stored}) AS s2 EXCEPT SELECT * FROM (${expected}) AS e2) AS diff`;

/** Stored pairs of the orders `orderIds` selects that differ from their sources. */
export function recommendationPairsDriftSql(orderIds: string): string {
  return symmetricDifference(recommendationPairs(orderIds),
    `SELECT order_id, product_id, created_at, buyer FROM recommendation_order_products WHERE order_id IN (${orderIds})`);
}

/** Rewrites the pairs of the orders `orderIds` selects (one batch). */
export function recommendationPairsRepairStatements(orderIds: string): string[] {
  return [
    `DELETE FROM recommendation_order_products WHERE order_id IN (${orderIds})`,
    `INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer) ${recommendationPairs(orderIds)}`,
  ];
}

const incoming = (ref: string) => `${ref}.kind = 'message' AND ${ref}.visibility = 'public' AND ${ref}.author_type IN ('customer', 'guest_receipt')`;
const open = (ref: string) => `(${ref}.status = 'open' AND ${ref}.last_message_at IS NOT NULL)`;
const openCount = (ref: string) => `(CASE WHEN ${open(ref)} THEN 1 ELSE 0 END)`;
const unassignedCount = (ref: string) => `(CASE WHEN ${open(ref)} AND ${ref}.assignee_user_id IS NULL THEN 1 ELSE 0 END)`;

const unreadTotal = `(SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.last_message_at IS NOT NULL AND m.seq > c.staff_read_seq AND ${incoming("m")})`;

// External upgrades require the verified write freeze in upgrade-provider-schema.ts; this backfill is not an online migration.
export const conversationInboxCountsBackfill = [
  `INSERT INTO conversation_inbox_counts (scope, unread, open, unassigned_open)
SELECT '*',
  ${unreadTotal},
  coalesce(sum(${openCount("c")}), 0), coalesce(sum(${unassignedCount("c")}), 0)
FROM conversations c;`,
  `INSERT INTO conversation_inbox_counts (scope, open)
SELECT 'u:' || assignee_user_id, count(*) FROM conversations c
WHERE ${open("c")} AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id;`,
];

/** Run as one transaction; normal writes use only trigger deltas. */
export const conversationInboxCountsRebuild = ["DELETE FROM conversation_inbox_counts;", ...conversationInboxCountsBackfill];

/** Counter rows that differ from the conversations (a zero assignee row equals none). */
export const conversationInboxCountsDriftSql = symmetricDifference(
  `SELECT '*' AS scope, ${unreadTotal} AS unread, coalesce(sum(${openCount("c")}), 0) AS open,
      coalesce(sum(${unassignedCount("c")}), 0) AS unassigned_open FROM conversations c
    UNION ALL SELECT 'u:' || assignee_user_id, 0, count(*), 0 FROM conversations c
    WHERE ${open("c")} AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id`,
  `SELECT scope, unread, open, unassigned_open FROM conversation_inbox_counts
    WHERE scope = '*' OR unread <> 0 OR open <> 0 OR unassigned_open <> 0`,
);
