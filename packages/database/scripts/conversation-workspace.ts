/** Product cards are public staff replies, never notes or buyer-supplied snapshots. */
export const conversationProductReplyGuard = `CREATE TRIGGER conversation_product_reply_shape
BEFORE INSERT ON conversation_messages
WHEN NEW.event_kind = 'product_reply' AND (
  NEW.visibility <> 'public' OR NEW.author_type <> 'staff' OR NEW.event_data IS NULL
  OR (NEW.body IS NOT NULL AND length(trim(NEW.body)) = 0)
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid public product reply');
END`;

/** Prefix ranges use binary ordering on SQLite and C ordering on PostgreSQL. */
export function conversationSearchPostgresCollation(ddl: string): string {
  if (!/CREATE TABLE\s+"?conversation_search_terms"?/i.test(ddl)) return ddl;
  const result = ddl.replace(
    /(CREATE TABLE\s+"?conversation_search_terms"?\s*\([^;]*?"term"\s+text)(\s+NOT NULL)/i,
    '$1 COLLATE "C"$2',
  );
  if (!/CREATE TABLE\s+"?conversation_search_terms"?\s*\([^;]*?"term"\s+text COLLATE "C"/i.test(result)) {
    throw new Error("conversation_search_terms.term missing C collation");
  }
  return result;
}
