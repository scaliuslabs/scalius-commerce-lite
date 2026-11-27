// How remote D1 cuts a migration file into statements. Kept import-free:
// scripts/migration-writes.mjs imports this file under plain Node (type
// stripping), and migration-plan.ts re-exports it.

/**
 * How remote D1 splits a migration: Wrangler sends each file as one string and
 * Cloudflare's server cuts it into statements with the legacy splitter
 * (Wrangler <= 3.20's, after atdatabases' split-sql-query): outside quotes and
 * comments a `;` ends a statement, except inside a trigger block, which opens
 * at whitespace, `BEGIN`, whitespace and closes at whitespace, an uppercase
 * `END`, then `;` or whitespace. So an uppercase `END` followed by whitespace
 * inside a trigger body (a CASE's) cuts the trigger there, and D1 answers
 * `incomplete input`. Inside a body write `END)`, `END,` or lowercase `end`;
 * only the trigger's own final `END;` may close it. Statements come back
 * trimmed, without their `;`.
 */
export function splitD1MigrationLikeRemote(sql: string): string[] {
  const statements: string[] = [];
  const chars = [...sql.trim()];
  let current = "";
  // Open trigger blocks: the legacy splitter stacks one per `BEGIN` and pops one per `END`.
  let blocks = 0;
  let index = 0;
  // The characters up to and including the next `marker` (to the end when there is none).
  const takeUntil = (marker: string) => {
    let taken = "";
    while (index < chars.length) {
      taken += chars[index++];
      if (taken.endsWith(marker)) break;
    }
    return taken;
  };
  while (index < chars.length) {
    const char = chars[index++]!;
    if (blocks > 0 && /\sEND[;\s]$/.test(current + char)) blocks -= 1;
    if (char === "'" || char === '"' || char === "`") {
      current += char + takeUntil(char);
    } else if (char === "-" && chars[index] === "-") {
      index += 1;
      current += "--" + takeUntil("\n");
    } else if (char === "/" && chars[index] === "*") {
      index += 1;
      current += "/*" + takeUntil("*/");
    } else if (char === ";" && blocks === 0) {
      statements.push(current);
      current = "";
    } else {
      current += char;
    }
    if (/\sBEGIN\s$/.test(current)) blocks += 1;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter(Boolean);
}
