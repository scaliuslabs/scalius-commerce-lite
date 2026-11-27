// What a new migration writes when it runs, declared in the file where its
// reviewer reads it.
//
// D1 applies one migration file in one request, all or nothing, and bills
// every row it writes (index entries included) against the plan's daily
// quota: Free allows 100,000 rows written a day (docs/FREE-PLAN.md). A file
// that rewrites a table in proportion to the store's size can therefore never
// apply on a large Free store, which then stays on its old release. Two
// migrations were rewritten by hand for exactly that (0221, 0225). So a
// migration that rewrites existing rows says so, table by table, with the
// basis of its estimate:
//
//   -- rewrites orders: one UPDATE per order still 'processing' (bounded by the store's order count)
//
// and the review of that line is the decision to spend the budget. Deployed
// migrations (through 0226) are immutable and exempt by number.
//
// Statements inside a trigger body run later, on each write, never at
// migration time: they are not rewrites. Their remote D1 quirks are checked
// here instead: Cloudflare's server rejects a trigger body that embeds
// `SELECT CASE WHEN` (the guard belongs in the trigger's WHEN clause); the
// uppercase `END` cut is checked for every file by `splitD1MigrationLikeRemote`
// (migration-plan.test.ts).

// A TypeScript file under plain Node: type stripping, on by default from Node 24.21 (the repo's engine).
let splitD1MigrationLikeRemote;
try {
  ({ splitD1MigrationLikeRemote } = await import("../src/d1-remote-split.ts"));
} catch (error) {
  throw new Error(
    `The migration write gate loads packages/database/src/d1-remote-split.ts with Node's TypeScript type stripping, `
    + `which needs Node 24.21 or later (this is ${process.version}; the repository's engines field and .nvmrc name 24.21): ${error instanceof Error ? error.message : String(error)}`,
  );
}

export const FIRST_WRITE_GATED_MIGRATION = 227;
export const MIN_ESTIMATE_BASIS_LENGTH = 20;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
// A name, bare or quoted (a quoted one may hold spaces), optionally schema-qualified (`main.orders`).
const NAME = String.raw`(?:[A-Za-z_]\w*|"[^"]+"|\`[^\`]+\`|\[[^\]]+\])`;
const IDENTIFIER = String.raw`(?:${NAME}\s*\.\s*)?(${NAME})`;
const DECLARATION = new RegExp(String.raw`^--\s*rewrites\s+(${NAME})\s*:\s*(.*?)\s*$`, "gim");

/** A table name without its quotes, as SQLite resolves it (case-insensitively). */
function unquoted(name) {
  return /^["`[]/.test(name) ? name.slice(1, -1) : name;
}
const sameTable = (name) => unquoted(name).toLowerCase();

/** The statement without its leading comments, as SQLite reads it. */
function executable(statement) {
  return statement.replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/g, "").trim();
}

/**
 * Every statement, as remote D1 cuts the file: on the breakpoints, then inside
 * each chunk with the server's own splitter (two statements on one line, or a
 * trigger followed by an UPDATE without a breakpoint, are two statements there).
 */
function statementsOf(sql) {
  return sql.split(STATEMENT_BREAKPOINT).flatMap((chunk) => (chunk.trim() ? splitD1MigrationLikeRemote(chunk) : []));
}

/** The text after a balanced parenthesised group that starts at `text[0]`, or null. */
function afterParentheses(text) {
  if (text[0] !== "(") return text;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(index + 1).trimStart();
    }
  }
  return null;
}

/** The `-- rewrites <table>: <basis>` lines of a migration. */
export function parseRewriteDeclarations(sql) {
  return [...sql.matchAll(DECLARATION)].map((match) => ({ table: unquoted(match[1]), basis: match[2] }));
}

function insertRewrites(rest) {
  // INSERT [OR x] INTO t [AS a] [(columns)] then SELECT/WITH (rows copied) or VALUES/DEFAULT (constant rows).
  const match = new RegExp(String.raw`^(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${IDENTIFIER}\s*(?:AS\s+\w+\s*)?`, "i").exec(rest);
  if (!match) return null;
  const tail = afterParentheses(rest.slice(match[0].length));
  if (tail === null || !/^(?:SELECT|WITH)\b/i.test(tail)) return null;
  return { table: unquoted(match[1]), kind: "insert-select" };
}

/**
 * The top-level statements of a migration that write existing rows, each with
 * the table it writes: UPDATE, DELETE, INSERT ... SELECT (a backfill or a
 * table rebuild's copy), CREATE TABLE ... AS SELECT, and an index created on
 * a table this file did not create (one entry per existing row).
 */
export function rowRewritingStatements(sql) {
  const created = new Set();
  const found = [];
  for (const raw of statementsOf(sql)) {
    const statement = executable(raw);
    const createTable = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "i").exec(statement);
    if (createTable) {
      if (/\bAS\s+(?:SELECT|WITH)\b/i.test(statement.slice(createTable[0].length, createTable[0].length + 40))) {
        found.push({ table: unquoted(createTable[1]), kind: "create-table-as", statement });
      }
      created.add(sameTable(createTable[1]));
      continue;
    }
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(statement)) continue;
    const index = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}\s+ON\s+${IDENTIFIER}`, "i").exec(statement);
    if (index) {
      if (!created.has(sameTable(index[2]))) found.push({ table: unquoted(index[2]), kind: "index-on-existing-table", statement });
      continue;
    }
    // A leading WITH: the main statement is the first write keyword after the CTEs (their bodies are SELECTs).
    let rest = statement;
    if (/^WITH\b/i.test(statement)) {
      const main = /(?:^|[\s)])((?:UPDATE|INSERT|REPLACE|DELETE)\s[\s\S]*)$/i.exec(statement.slice(4));
      if (!main) continue;
      rest = main[1];
      if (/^(?:INSERT|REPLACE)\b/i.test(rest)) {
        const into = new RegExp(String.raw`^(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${IDENTIFIER}`, "i").exec(rest);
        if (into) found.push({ table: unquoted(into[1]), kind: "insert-select", statement });
        continue;
      }
    }
    const update = new RegExp(String.raw`^UPDATE(?:\s+OR\s+\w+)?\s+${IDENTIFIER}`, "i").exec(rest);
    if (update) {
      found.push({ table: unquoted(update[1]), kind: "update", statement });
      continue;
    }
    const remove = new RegExp(String.raw`^DELETE\s+FROM\s+${IDENTIFIER}`, "i").exec(rest);
    if (remove) {
      found.push({ table: unquoted(remove[1]), kind: "delete", statement });
      continue;
    }
    const insert = insertRewrites(rest);
    if (insert) found.push({ ...insert, statement });
  }
  return found;
}

/**
 * Trigger bodies remote D1 refuses or cuts differently from SQLite: an
 * embedded `SELECT CASE WHEN`, or a body not closed the way the server's
 * splitter closes it (the trigger's own final `END`, uppercase, and no other
 * uppercase `END` followed by whitespace inside: write `END)` there, as
 * AGENTS.md says). A body closed `end;` swallows the statements after it on
 * the server, so its statements could not be read reliably here either.
 */
export function remoteD1TriggerFindings(sql) {
  const findings = [];
  for (const raw of statementsOf(sql)) {
    const statement = executable(raw);
    if (/^END\b/i.test(statement)) {
      findings.push("a trigger body was cut short by an uppercase END followed by a space or ; inside it (remote D1 closes the trigger there): write END) inside a body");
      continue;
    }
    const trigger = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, "i").exec(statement);
    if (!trigger) continue;
    if (!/\sEND$/.test(statement)) {
      findings.push(`trigger ${unquoted(trigger[1])} is not closed the way remote D1 cuts it: end its body with an uppercase END; and write END) (not END followed by a space) inside it`);
      continue;
    }
    const body = statement.slice(statement.search(/\bBEGIN\b/i));
    if (/\bSELECT\s+CASE\s+WHEN\b/i.test(body)) {
      findings.push(`trigger ${unquoted(trigger[1])} embeds SELECT CASE WHEN in its body, which remote D1 rejects: put the guard in the trigger's WHEN clause`);
    }
  }
  return findings;
}

const KIND_WORDS = {
  update: "updates",
  delete: "deletes rows of",
  "insert-select": "copies rows into",
  "create-table-as": "fills from a query",
  "index-on-existing-table": "indexes every existing row of",
};

/**
 * The gate's findings for one migration file: every table a statement
 * rewrites is declared with an estimate basis, every declaration names a
 * table the file really rewrites, and no trigger body breaks remote D1.
 * Empty for a deployed migration (below FIRST_WRITE_GATED_MIGRATION).
 */
export function migrationWriteFindings(file, sql) {
  const version = Number(file.slice(0, 4));
  if (!Number.isInteger(version) || version < FIRST_WRITE_GATED_MIGRATION) return [];
  const findings = [];
  const declarations = parseRewriteDeclarations(sql);
  const declared = new Map();
  for (const { table, basis } of declarations) {
    if (basis.length < MIN_ESTIMATE_BASIS_LENGTH) {
      findings.push(`${file}: "-- rewrites ${table}:" needs the basis of its estimate (how many rows, bounded by what), at least ${MIN_ESTIMATE_BASIS_LENGTH} characters`);
    }
    declared.set(table.toLowerCase(), basis);
  }
  const rewritten = new Set();
  for (const { table, kind } of rowRewritingStatements(sql)) {
    rewritten.add(table.toLowerCase());
    if (!declared.has(table.toLowerCase())) {
      findings.push(
        `${file} ${KIND_WORDS[kind]} ${table} without declaring it: add "-- rewrites ${table}: <rows written, bounded by what>" `
        + "(D1 bills every row and index entry against the plan's daily write quota, and a file applies all or nothing), "
        + "or move growing work to a chunked drain",
      );
    }
  }
  for (const { table } of declarations) {
    if (!rewritten.has(table.toLowerCase())) {
      findings.push(`${file} declares "-- rewrites ${table}" but no statement rewrites ${table}: remove the line`);
    }
  }
  for (const finding of remoteD1TriggerFindings(sql)) findings.push(`${file}: ${finding}`);
  return [...new Set(findings)];
}
