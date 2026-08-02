/**
 * Runtime compiler for Scalius' deliberately small SQLite SQL profile.
 *
 * The application keeps one query model for D1/Turso. PostgreSQL support is
 * therefore allowed only through this fail-closed compiler plus the matching
 * compatibility schema below. Unsupported syntax must be rejected here or by
 * the PostgreSQL parity suite; provider conditionals do not belong in commerce
 * services.
 */

export interface CompiledPostgresStatement {
  sql: string;
  parameterCount: number;
  readOnly: boolean;
}

type ScannerState =
  | "normal"
  | "single-quote"
  | "double-quote"
  | "line-comment"
  | "block-comment";

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readDelimitedIdentifier(
  sql: string,
  start: number,
  opening: "`" | "[",
): { value: string; end: number } {
  const closing = opening === "[" ? "]" : "`";
  let cursor = start + 1;
  let value = "";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (character === closing) {
      if (sql[cursor + 1] === closing) {
        value += closing;
        cursor += 2;
        continue;
      }
      return { value, end: cursor + 1 };
    }
    value += character;
    cursor += 1;
  }
  throw new Error("SQLite SQL contains an unterminated quoted identifier.");
}

function classifyReadOnly(sql: string): boolean {
  // WITH is deliberately treated as write-capable: it can contain a mutation.
  // A conservative false only adds a transaction; a false true can violate the
  // write contract.
  return /^\s*(?:select\b|explain(?:\s+query\s+plan)?\s+select\b)/i.test(sql);
}

interface FollowingWord {
  start: number;
  end: number;
  normalized: string;
}

function readFollowingWord(sql: string, start: number): FollowingWord | null {
  let cursor = start;
  while (cursor < sql.length && /\s/.test(sql[cursor]!)) cursor += 1;
  if (cursor >= sql.length || !isIdentifierStart(sql[cursor]!)) return null;
  const wordStart = cursor;
  cursor += 1;
  while (cursor < sql.length && isIdentifierPart(sql[cursor]!)) cursor += 1;
  return {
    start: wordStart,
    end: cursor,
    normalized: sql.slice(wordStart, cursor).toLowerCase(),
  };
}

const POSTGRES_IS_PREDICATES = new Set([
  "null",
  "true",
  "false",
  "unknown",
  "distinct",
]);

const POSTGRES_AS_SYNTAX_WORDS = new Set([
  "bigint",
  "blob",
  "boolean",
  "bytea",
  "character",
  "date",
  "decimal",
  "double",
  "integer",
  "interval",
  "json",
  "jsonb",
  "materialized",
  "not",
  "null",
  "numeric",
  "precision",
  "real",
  "text",
  "time",
  "timestamp",
  "uuid",
  "varchar",
]);

/**
 * SQLite's binary IS / IS NOT operators are null-safe equality. PostgreSQL's
 * same spellings are predicates restricted to NULL/boolean/unknown, so binary
 * comparisons must use IS [NOT] DISTINCT FROM. Quoted text and comments are
 * deliberately opaque.
 */
export function compileSqliteNullSafeComparisons(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";

  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = cursor + 1;
      while (end < sql.length && isIdentifierPart(sql[end]!)) end += 1;
      const word = sql.slice(cursor, end);
      if (word.toLowerCase() !== "is") {
        output += word;
        cursor = end;
        continue;
      }

      const first = readFollowingWord(sql, end);
      if (first?.normalized === "not") {
        const second = readFollowingWord(sql, first.end);
        if (!second || !POSTGRES_IS_PREDICATES.has(second.normalized)) {
          output += "IS DISTINCT FROM";
          cursor = first.end;
          continue;
        }
      } else if (!first || !POSTGRES_IS_PREDICATES.has(first.normalized)) {
        output += "IS NOT DISTINCT FROM";
        cursor = end;
        continue;
      }
      output += word;
      cursor = end;
      continue;
    }
    output += character;
    cursor += 1;
  }

  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  return output;
}

/**
 * Checkout guards intentionally call json_extract() with an invalid non-path
 * only on the failing CASE branch. SQLite permits that dynamic result shape;
 * PostgreSQL resolves CASE types before execution, so use a typed raising
 * function while preserving the exact stable error message.
 */
export function compileSqliteErrorSentinels(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    const sentinel = /^json_extract\s*\(\s*'\{\}'\s*,\s*('(?:''|[^'])+')\s*\)/i.exec(
      sql.slice(cursor),
    );
    if (sentinel) {
      output += `scalius_compat.fail_bigint(${sentinel[1]})`;
      cursor += sentinel[0].length;
      continue;
    }
    output += character;
    cursor += 1;
  }
  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  return output;
}

function findSqlCallEnd(sql: string, openingParenthesis: number): number {
  let cursor = openingParenthesis + 1;
  let depth = 1;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") cursor += 1;
      else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') cursor += 1;
      else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") state = "single-quote";
    else if (character === '"') state = "double-quote";
    else if (character === "-" && sql[cursor + 1] === "-") {
      state = "line-comment";
      cursor += 1;
    } else if (character === "/" && sql[cursor + 1] === "*") {
      state = "block-comment";
      cursor += 1;
    } else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  throw new Error("SQLite SQL contains an unterminated function call.");
}

function splitSqlCallArguments(body: string): string[] {
  const argumentsList: string[] = [];
  let start = 0;
  let cursor = 0;
  let depth = 0;
  let state: ScannerState = "normal";
  while (cursor < body.length) {
    const character = body[cursor]!;
    if (state === "single-quote") {
      cursor += 1;
      if (character === "'" && body[cursor] === "'") cursor += 1;
      else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      cursor += 1;
      if (character === '"' && body[cursor] === '"') cursor += 1;
      else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      cursor += 1;
      if (character === "*" && body[cursor] === "/") {
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") state = "single-quote";
    else if (character === '"') state = "double-quote";
    else if (character === "-" && body[cursor + 1] === "-") {
      state = "line-comment";
      cursor += 1;
    } else if (character === "/" && body[cursor + 1] === "*") {
      state = "block-comment";
      cursor += 1;
    } else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      argumentsList.push(body.slice(start, cursor).trim());
      start = cursor + 1;
    }
    cursor += 1;
  }
  argumentsList.push(body.slice(start).trim());
  return argumentsList;
}

function postgresJsonObjectValue(expression: string): string {
  const trimmed = compileSqliteJsonObjects(expression).trim();
  if (/^json_extract\s*\(/i.test(trimmed)) {
    const opening = trimmed.indexOf("(");
    if (opening >= 0 && findSqlCallEnd(trimmed, opening) === trimmed.length - 1) {
      return `scalius_compat.json_extract_jsonb${trimmed.slice(opening)}`;
    }
  }
  return trimmed;
}

const POSTGRES_JSONB_EACH_HINT = "/* scalius:postgres-jsonb */";

/**
 * An inert comment opts a hot json_each() source into a JSONB-valued Postgres
 * table function. SQLite/Turso ignore the comment and retain their native JSON
 * subtype; PostgreSQL avoids reparsing the same nested object for every field.
 */
export function compileSqliteJsonbEachHints(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    const call = /^json_each\s*\(/i.exec(sql.slice(cursor));
    if (call) {
      const opening = cursor + call[0].lastIndexOf("(");
      const closing = findSqlCallEnd(sql, opening);
      const body = sql.slice(opening + 1, closing);
      if (body.includes(POSTGRES_JSONB_EACH_HINT)) {
        output += `scalius_compat.json_each_jsonb(${body.replace(
          POSTGRES_JSONB_EACH_HINT,
          "",
        )})`;
        cursor = closing + 1;
        continue;
      }
    }
    output += character;
    cursor += 1;
  }
  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  return output;
}

/**
 * Lower literal SQLite JSON paths to PostgreSQL's native jsonb operator. The
 * scalar conversion preserves SQLite's boolean-as-0/1 and unquoted string
 * behavior, while marked JSONB rows avoid both JSON reparsing and path parsing
 * for every projected field.
 */
export function compileSqliteJsonExtractPaths(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    const call = /^json_extract\s*\(/i.exec(sql.slice(cursor));
    if (call) {
      const opening = cursor + call[0].lastIndexOf("(");
      const closing = findSqlCallEnd(sql, opening);
      const argumentsList = splitSqlCallArguments(sql.slice(opening + 1, closing));
      if (argumentsList.length === 2) {
        const pathMatch = /^'\$((?:\.[A-Za-z0-9_]+)*)'$/.exec(argumentsList[1]!);
        if (pathMatch) {
          const input = compileSqliteJsonExtractPaths(argumentsList[0]!);
          const segments = pathMatch[1]
            ? pathMatch[1].slice(1).split(".")
            : [];
          const value = segments.length === 0
            ? `((${input})::jsonb)`
            : `jsonb_extract_path((${input})::jsonb, ${segments.map((segment) =>
              `'${segment.replaceAll("'", "''")}'`
            ).join(", ")})`;
          output += `scalius_compat.json_scalar_text(${value})`;
          cursor = closing + 1;
          continue;
        }
      }
    }
    output += character;
    cursor += 1;
  }
  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  return output;
}

/**
 * PostgreSQL's json_object name is parser-owned and its text-array overload
 * cannot preserve SQLite JSON subtypes. Rebuild application json_object()
 * calls with jsonb_build_object, routing direct json_extract() values through
 * a jsonb-returning twin so arrays, objects, numbers, booleans, strings, and
 * null retain their exact JSON kinds.
 */
export function compileSqliteJsonObjects(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && sql[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && sql[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    const call = /^json_object\s*\(/i.exec(sql.slice(cursor));
    if (call) {
      const opening = cursor + call[0].lastIndexOf("(");
      const closing = findSqlCallEnd(sql, opening);
      const argumentsList = splitSqlCallArguments(sql.slice(opening + 1, closing));
      if (argumentsList.length === 0 || argumentsList.length % 2 !== 0) {
        throw new Error("SQLite json_object() requires key/value argument pairs.");
      }
      const compiledArguments = argumentsList.map((argument, index) =>
        index % 2 === 0
          ? compileSqliteJsonObjects(argument).trim()
          : postgresJsonObjectValue(argument)
      );
      output += `(jsonb_build_object(${compiledArguments.join(", ")})::text)`;
      cursor = closing + 1;
      continue;
    }
    output += character;
    cursor += 1;
  }
  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  return output;
}

/**
 * Compile one parameterized SQLite statement to PostgreSQL's wire syntax.
 * Values remain parameters; only trusted SQL generated by Drizzle/application
 * source is transformed.
 */
export function compileSqliteStatementForPostgres(
  sqliteSql: string,
  expectedParameterCount?: number,
): CompiledPostgresStatement {
  if (!sqliteSql.trim()) throw new Error("SQLite SQL statement must not be empty.");

  const source = compileSqliteJsonExtractPaths(compileSqliteJsonObjects(
    compileSqliteJsonbEachHints(compileSqliteErrorSentinels(
      compileSqliteNullSafeComparisons(sqliteSql),
    )),
  ));

  let state: ScannerState = "normal";
  let cursor = 0;
  let parameterCount = 0;
  let placeholderStyle: "anonymous" | "indexed" | null = null;
  let previousWord = "";
  let output = "";

  while (cursor < source.length) {
    const character = source[cursor]!;

    if (state === "single-quote") {
      output += character;
      cursor += 1;
      if (character === "'" && source[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "double-quote") {
      output += character;
      cursor += 1;
      if (character === '"' && source[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "line-comment") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }

    if (state === "block-comment") {
      output += character;
      cursor += 1;
      if (character === "*" && source[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }

    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double-quote";
      continue;
    }
    if (character === "-" && source[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line-comment";
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block-comment";
      continue;
    }
    if (character === "`" || character === "[") {
      const identifier = readDelimitedIdentifier(
        source,
        cursor,
        character,
      );
      output += quotePostgresIdentifier(identifier.value);
      cursor = identifier.end;
      previousWord = "";
      continue;
    }
    if (character === "?") {
      let end = cursor + 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      if (end > cursor + 1) {
        if (placeholderStyle === "anonymous") {
          throw new Error("SQLite SQL cannot mix anonymous and indexed placeholders.");
        }
        placeholderStyle = "indexed";
        const indexText = source.slice(cursor + 1, end);
        const index = Number(indexText);
        if (!Number.isSafeInteger(index) || index < 1) {
          throw new Error(`SQLite SQL placeholder ?${indexText} is invalid.`);
        }
        parameterCount = Math.max(parameterCount, index);
        output += `$${index}`;
        cursor = end;
      } else {
        if (placeholderStyle === "indexed") {
          throw new Error("SQLite SQL cannot mix indexed and anonymous placeholders.");
        }
        placeholderStyle = "anonymous";
        parameterCount += 1;
        output += `$${parameterCount}`;
        cursor += 1;
      }
      previousWord = "";
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = cursor + 1;
      while (end < source.length && isIdentifierPart(source[end]!)) end += 1;
      const original = source.slice(cursor, end);
      const normalized = original.toLowerCase();
      const followedByCall = /^\s*\(/.test(source.slice(end));
      let replacement = original;
      if (normalized === "true") replacement = "1";
      else if (normalized === "false") replacement = "0";
      else if (normalized === "like") replacement = "ILIKE";
      else if (normalized === "group_concat") replacement = "string_agg";
      else if (normalized === "integer" && previousWord === "as") replacement = "bigint";
      // PostgreSQL parses json(text) as a type cast before looking for the
      // compatibility function. Use an unambiguous namespaced function for
      // SQLite's canonicalizing json() call.
      else if (normalized === "json" && followedByCall) {
        replacement = "scalius_compat.json_text";
      }
      // PostgreSQL folds unquoted aliases to lowercase; SQLite preserves the
      // spelling. Quote only mixed-case aliases emitted by raw application SQL
      // so typed row keys such as variantId remain provider-identical.
      else if (
        previousWord === "as"
        && /[A-Z]/.test(original)
        && !POSTGRES_AS_SYNTAX_WORDS.has(normalized)
      ) {
        replacement = quotePostgresIdentifier(original);
      }
      output += replacement;
      previousWord = normalized;
      cursor = end;
      continue;
    }

    output += character;
    cursor += 1;
    if (!/\s/.test(character) && character !== ".") previousWord = "";
  }

  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  if (
    expectedParameterCount !== undefined
    && parameterCount !== expectedParameterCount
  ) {
    throw new Error(
      `SQLite SQL parameter count ${parameterCount} does not match ${expectedParameterCount}.`,
    );
  }

  return {
    sql: output,
    parameterCount,
    readOnly: classifyReadOnly(sqliteSql),
  };
}

/**
 * Normalize values already encoded by Drizzle's SQLite mappers for Postgres.
 */
export function normalizePostgresParameters(
  parameters: readonly unknown[],
): readonly unknown[] {
  return parameters.map((value) => typeof value === "boolean" ? Number(value) : value);
}

/** PostgreSQL OIDs returned by the Neon HTTP full-results protocol. */
const INTEGER_RESULT_OIDS = new Set([20, 21, 23, 26]);
const FLOAT_RESULT_OIDS = new Set([700, 701, 1700]);

export function normalizePostgresResultRows(
  rows: readonly (readonly unknown[])[],
  fields: readonly { dataTypeID: number }[],
): unknown[][] {
  return rows.map((row) => row.map((value, index) => {
    if (value === null || value === undefined) return value;
    const oid = fields[index]?.dataTypeID;
    if (
      typeof value === "string"
      && (INTEGER_RESULT_OIDS.has(oid ?? -1) || FLOAT_RESULT_OIDS.has(oid ?? -1))
    ) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new Error("PostgreSQL returned a non-finite numeric value.");
      }
      if (INTEGER_RESULT_OIDS.has(oid ?? -1) && !Number.isSafeInteger(numeric)) {
        throw new Error("PostgreSQL integer exceeds JavaScript's safe range.");
      }
      return numeric;
    }
    return value;
  }));
}

export function normalizePostgresResultObjects(
  rows: readonly (readonly unknown[])[],
  fields: readonly { name: string; dataTypeID: number }[],
): Record<string, unknown>[] {
  const normalized = normalizePostgresResultRows(rows, fields);
  return normalized.map((row) => Object.fromEntries(row.map((value, index) => {
    const name = fields[index]?.name;
    if (!name) throw new Error("PostgreSQL result field is missing its name.");
    return [name, value];
  })));
}

/**
 * Compatibility functions for the SQLite profile used by application SQL.
 * They intentionally live in a dedicated schema; public wrappers are exposed
 * only for names that existing queries call unqualified.
 */
export const POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL = String.raw`
CREATE SCHEMA IF NOT EXISTS scalius_compat;

CREATE OR REPLACE FUNCTION scalius_compat.json_path_value(input_text text, json_path text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parsed jsonb;
  path_parts text[];
BEGIN
  parsed := input_text::jsonb;
  IF json_path = '$' THEN
    RETURN parsed;
  END IF;
  IF json_path !~ '^\$\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$' THEN
    RAISE EXCEPTION 'unsupported SQLite JSON path: %', json_path USING ERRCODE = '22023';
  END IF;
  path_parts := string_to_array(substr(json_path, 3), '.');
  RETURN parsed #> path_parts;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_path_value(input_json jsonb, json_path text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  path_parts text[];
BEGIN
  IF json_path = '$' THEN
    RETURN input_json;
  END IF;
  IF json_path !~ '^\$\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$' THEN
    RAISE EXCEPTION 'unsupported SQLite JSON path: %', json_path USING ERRCODE = '22023';
  END IF;
  path_parts := string_to_array(substr(json_path, 3), '.');
  RETURN input_json #> path_parts;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_scalar_text(value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE jsonb_typeof(value)
    WHEN 'null' THEN NULL
    WHEN 'string' THEN value #>> '{}'
    WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN '1' ELSE '0' END
    ELSE value::text
  END
$function$;

CREATE OR REPLACE FUNCTION public.unixepoch()
RETURNS bigint
LANGUAGE sql
STABLE
AS $function$
  SELECT floor(extract(epoch FROM statement_timestamp()))::bigint
$function$;

CREATE OR REPLACE FUNCTION public.instr(haystack text, needle text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT strpos(haystack, needle)::bigint
$function$;

CREATE OR REPLACE FUNCTION public.json_valid(input_text text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  PERFORM input_text::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_text(input_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT input_text::jsonb::text
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.fail_bigint(message_text text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
STRICT
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = message_text;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.json_extract(input_text text, json_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT scalius_compat.json_scalar_text(
    scalius_compat.json_path_value(input_text, json_path)
  )
$function$;

CREATE OR REPLACE FUNCTION public.json_extract(input_json jsonb, json_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT scalius_compat.json_scalar_text(
    scalius_compat.json_path_value(input_json, json_path)
  )
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_extract_jsonb(input_text text, json_path text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT scalius_compat.json_path_value(input_text, json_path)
$function$;

CREATE OR REPLACE FUNCTION public.json_type(input_text text, json_path text DEFAULT '$')
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  value jsonb;
  kind text;
BEGIN
  value := scalius_compat.json_path_value(input_text, json_path);
  IF value IS NULL THEN RETURN NULL; END IF;
  kind := jsonb_typeof(value);
  IF kind = 'number' THEN
    RETURN CASE WHEN value::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END;
  END IF;
  RETURN CASE kind
    WHEN 'string' THEN 'text'
    WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN 'true' ELSE 'false' END
    ELSE kind
  END;
END
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_text text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT jsonb_array_length(input_text::jsonb)::bigint
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_text text, json_path text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT jsonb_array_length(
    scalius_compat.json_path_value(input_text, json_path)
  )::bigint
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_json jsonb, json_path text DEFAULT '$')
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT jsonb_array_length(
    scalius_compat.json_path_value(input_json, json_path)
  )::bigint
$function$;

CREATE OR REPLACE FUNCTION public.json_each(input_text text, json_path text DEFAULT '$')
RETURNS TABLE(
  key text,
  value text,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_text, json_path);
  IF jsonb_typeof(target) = 'array' THEN
    RETURN QUERY
      SELECT
        (entry.ordinality - 1)::text,
        scalius_compat.json_scalar_text(entry.element),
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        entry.ordinality::bigint,
        NULL::bigint,
        json_path || '[' || (entry.ordinality - 1)::text || ']',
        json_path
      FROM jsonb_array_elements(target) WITH ORDINALITY AS entry(element, ordinality);
  ELSIF jsonb_typeof(target) = 'object' THEN
    RETURN QUERY
      SELECT
        entry.object_key,
        scalius_compat.json_scalar_text(entry.element),
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        row_number() OVER (ORDER BY entry.object_key)::bigint,
        NULL::bigint,
        json_path || '.' || entry.object_key,
        json_path
      FROM jsonb_each(target) AS entry(object_key, element);
  ELSE
    RAISE EXCEPTION 'json_each() requires an array or object' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_each_jsonb(
  input_json jsonb,
  json_path text DEFAULT '$'
)
RETURNS TABLE(
  key text,
  value jsonb,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_json, json_path);
  IF jsonb_typeof(target) = 'array' THEN
    RETURN QUERY
      SELECT
        (entry.ordinality - 1)::text,
        entry.element,
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        entry.ordinality::bigint,
        NULL::bigint,
        json_path || '[' || (entry.ordinality - 1)::text || ']',
        json_path
      FROM jsonb_array_elements(target) WITH ORDINALITY AS entry(element, ordinality);
  ELSIF jsonb_typeof(target) = 'object' THEN
    RETURN QUERY
      SELECT
        entry.object_key,
        entry.element,
        public.json_type(entry.element::text),
        CASE WHEN jsonb_typeof(entry.element) IN ('array', 'object') THEN NULL
             ELSE scalius_compat.json_scalar_text(entry.element) END,
        row_number() OVER (ORDER BY entry.object_key)::bigint,
        NULL::bigint,
        json_path || '.' || entry.object_key,
        json_path
      FROM jsonb_each(target) AS entry(object_key, element);
  ELSE
    RAISE EXCEPTION 'json_each() requires an array or object' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_each_jsonb(
  input_text text,
  json_path text DEFAULT '$'
)
RETURNS TABLE(
  key text,
  value jsonb,
  type text,
  atom text,
  id bigint,
  parent bigint,
  fullkey text,
  path text
)
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT * FROM scalius_compat.json_each_jsonb(input_text::jsonb, json_path)
$function$;

CREATE OR REPLACE FUNCTION public.json_object(VARIADIC entries text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
  IF coalesce(array_length(entries, 1), 0) % 2 <> 0 THEN
    RAISE EXCEPTION 'json_object() requires an even number of arguments' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_object(entries)::text;
END
$function$;

CREATE OR REPLACE FUNCTION public.datetime(epoch_seconds bigint, modifier text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
BEGIN
  IF lower(modifier) <> 'unixepoch' THEN
    RAISE EXCEPTION 'unsupported datetime() modifier: %', modifier USING ERRCODE = '22023';
  END IF;
  RETURN to_char(to_timestamp(epoch_seconds) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
END
$function$;

CREATE OR REPLACE FUNCTION public.strftime(format_text text, value_text text)
RETURNS text
LANGUAGE plpgsql
STABLE
STRICT
AS $function$
DECLARE
  value_timestamp timestamp;
BEGIN
  IF lower(value_text) = 'now' THEN
    value_timestamp := statement_timestamp() AT TIME ZONE 'UTC';
  ELSE
    value_timestamp := value_text::timestamp;
  END IF;
  RETURN CASE format_text
    WHEN '%s' THEN floor(extract(epoch FROM value_timestamp AT TIME ZONE 'UTC'))::bigint::text
    WHEN '%Y-%m-%d' THEN to_char(value_timestamp, 'YYYY-MM-DD')
    ELSE NULL
  END;
END
$function$;

CREATE OR REPLACE FUNCTION public.round(value double precision, digits bigint)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT round(value::numeric, digits::integer)::double precision
$function$;

CREATE OR REPLACE FUNCTION public.max(left_value bigint, right_value bigint)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT greatest(left_value, right_value)
$function$;

CREATE OR REPLACE FUNCTION public.max(left_value double precision, right_value double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT greatest(left_value, right_value)
$function$;

CREATE OR REPLACE FUNCTION public.min(left_value bigint, right_value bigint)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT least(left_value, right_value)
$function$;

CREATE OR REPLACE FUNCTION public.min(left_value double precision, right_value double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT least(left_value, right_value)
$function$;

CREATE OR REPLACE FUNCTION public.changes()
RETURNS bigint
LANGUAGE sql
STABLE
AS $function$
  SELECT coalesce(nullif(current_setting('scalius.changes', true), ''), '0')::bigint
$function$;
`;
