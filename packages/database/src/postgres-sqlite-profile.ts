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
  const input = expression.trim();
  const constructor = /^(?:json_object|json_array|json_group_array|json_set|json_insert|json_replace|json_remove|json)\s*\(/i.exec(input);
  const directJsonValue = constructor !== null
    && findSqlCallEnd(input, constructor[0].lastIndexOf("(")) === input.length - 1;
  // Only a complete constructor argument carries JSON into its consumer.
  // Subqueries still need text-valued JSON in predicates/table-function inputs.
  const trimmed = compileSqliteJsonObjects(input, directJsonValue).trim();
  if (/^json_extract\s*\(/i.test(trimmed)) {
    const opening = trimmed.indexOf("(");
    if (opening >= 0 && findSqlCallEnd(trimmed, opening) === trimmed.length - 1) {
      return `scalius_compat.json_extract_jsonb${trimmed.slice(opening)}`;
    }
  }
  return trimmed;
}

/**
 * A JSON editor's value with the JSON kind SQLite gives it: a bound value is
 * typed from its value, a JSON constructor or a whole `json_extract` call is
 * JSON. SQLite's `json_extract` is a number, text or JSON as the document
 * holds it, PostgreSQL's text: inside any other expression
 * (`coalesce(json_extract(...), 0)`) PostgreSQL would store a string where
 * SQLite stores a number, so that value is refused.
 */
function postgresJsonEditValue(name: string, expression: string): string {
  if (expression === "?") return `${POSTGRES_JSON_VALUE_PARAMETER_HINT} ?`;
  const call = /^(?:json_extract|json_object|json_array|json_group_array|json_set|json_insert|json_replace|json_remove|json)\s*\(/i.exec(expression);
  const whole = call !== null && findSqlCallEnd(expression, call[0].lastIndexOf("(")) === expression.length - 1;
  if (!whole && /\bjson_extract\s*\(/i.test(expression.replace(/'(?:''|[^'])*'/g, "''"))) {
    throw new Error(`SQLite ${name}() takes json_extract() only as the whole value: inside another expression PostgreSQL would store its text. Bind the value, or pass json_extract() alone.`);
  }
  return postgresJsonObjectValue(expression);
}

const POSTGRES_JSONB_EACH_HINT = "/* scalius:postgres-jsonb */";

/**
 * Marks a bare parameter that is a JSON editor's value. PostgreSQL types an
 * unannotated parameter from its use, and a `json_set` value can be of any
 * type, so the bound value decides (`typeJsonEditValues`).
 */
const POSTGRES_JSON_VALUE_PARAMETER_HINT = "/* scalius:json-value */";

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
export function compileSqliteJsonObjects(sql: string, jsonValue = false): string {
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
    const edit = cursor > 0 && (isIdentifierPart(sql[cursor - 1]!) || sql[cursor - 1] === ".")
      ? null
      : /^(json_set|json_insert|json_replace|json_remove)\s*\(/i.exec(sql.slice(cursor));
    if (edit) {
      const name = edit[1]!.toLowerCase();
      const opening = cursor + edit[0].lastIndexOf("(");
      const closing = findSqlCallEnd(sql, opening);
      const body = sql.slice(opening + 1, closing);
      const [document, ...rest] = (body.trim() ? splitSqlCallArguments(body) : []).map((argument) => argument.trim());
      if (document === undefined) throw new Error(`SQLite ${name}() needs a JSON argument.`);
      const compiled = (argument: string) => compileSqliteJsonObjects(argument).trim();
      let expression: string;
      if (name === "json_remove") {
        expression = `json_remove(${[document, ...rest].map(compiled).join(", ")})`;
      } else {
        if (rest.length % 2 !== 0) throw new Error(`SQLite ${name}() needs an odd number of arguments.`);
        expression = rest.length === 0 ? `scalius_compat.json_text(${compiled(document)})` : compiled(document);
        // SQLite applies the path/value pairs left to right: one call per pair,
        // each value keeping its JSON kind.
        for (let index = 0; index < rest.length; index += 2) {
          expression = `${name}(${expression}, ${compiled(rest[index]!)}, ${postgresJsonEditValue(name, rest[index + 1]!)})`;
        }
      }
      output += jsonValue ? `(${expression}::jsonb)` : expression;
      cursor = closing + 1;
      continue;
    }
    const call = /^(json_object|json_array|json_group_array|json)\s*\(/i.exec(sql.slice(cursor));
    if (call) {
      const kind = call[1]!.toLowerCase();
      const opening = cursor + call[0].lastIndexOf("(");
      const closing = findSqlCallEnd(sql, opening);
      const body = sql.slice(opening + 1, closing);
      const argumentsList = body.trim() ? splitSqlCallArguments(body) : [];
      if (kind === "json_object" && (argumentsList.length === 0 || argumentsList.length % 2 !== 0)) {
        throw new Error("SQLite json_object() requires key/value argument pairs.");
      }
      if ((kind === "json_group_array" || kind === "json") && argumentsList.length !== 1) {
        throw new Error(`SQLite ${kind}() requires one value argument.`);
      }
      const compiledArguments = argumentsList.map((argument, index) =>
        kind === "json" || (kind === "json_object" && index % 2 === 0)
          ? compileSqliteJsonObjects(argument).trim()
          : postgresJsonObjectValue(argument)
      );
      const expression = kind === "json"
        ? `scalius_compat.json_text(${compiledArguments[0]})`
        : kind === "json_group_array"
          ? `COALESCE(jsonb_agg(${compiledArguments[0]}), '[]'::jsonb)`
          : `${kind === "json_object" ? "jsonb_build_object" : "jsonb_build_array"}(${compiledArguments.join(", ")})`;
      // SQLite marks a constructor's result as JSON when another constructor
      // consumes it. json() explicitly marks a scalar subquery's result.
      output += kind === "json"
        ? jsonValue ? `(${expression}::jsonb)` : expression
        : jsonValue ? expression : `(${expression}::text)`;
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

/** Table qualifiers (`"t"."c"`, `t.c`, `` `t`.`c` ``) removed from every identifier outside string literals. */
function stripColumnQualifiers(text: string): string {
  return text
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => index % 2 === 1
      ? part
      : part.replace(/(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*(?=["`[A-Za-z_])/g, ""))
    .join("");
}

/**
 * Drizzle's SQLite dialect writes an insert's conflict target as qualified
 * columns (`on conflict ("t"."c")`), which SQLite accepts. PostgreSQL's
 * ON CONFLICT takes bare column names (or index expressions) and refuses a
 * qualified one with a syntax error, so the qualifiers go from the target list
 * alone: SET, WHERE and the rest of the statement keep their names.
 */
export function compileSqliteConflictTargets(sql: string): string {
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
    if ((character === "o" || character === "O") && !(cursor > 0 && isIdentifierPart(sql[cursor - 1]!))) {
      const conflict = /^on\s+conflict\s*\(/i.exec(sql.slice(cursor, cursor + 64));
      if (conflict) {
        const opening = cursor + conflict[0].length - 1;
        const closing = findSqlCallEnd(sql, opening);
        output += `${sql.slice(cursor, opening)}(${stripColumnQualifiers(sql.slice(opening + 1, closing))})`;
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

/** Words that can follow a FROM item without being its alias. */
const NOT_AN_ALIAS = new Set([
  "where", "join", "inner", "left", "right", "full", "cross", "natural", "on", "using", "group", "order",
  "limit", "offset", "union", "except", "intersect", "having", "window", "returning", "and", "or", "then",
  "else", "end", "when", "fetch", "for",
]);

/**
 * PostgreSQL plans every set-returning function at 1,000 rows, so a
 * `json_each(?)` lookup set of 24 ids planned like a table scan. With the
 * bound values in hand, each `json_each($n)` (or `json_each_jsonb($n)`)
 * whose parameter is a JSON array or object becomes a subquery capped at its
 * exact element count: the cap drops no row and gives the planner the real
 * size. Any other call is left as it is.
 */
export function compilePostgresJsonEachRowCounts(sql: string, params: readonly unknown[]): string {
  if (!/json_each/i.test(sql)) return sql;
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state !== "normal") {
      output += character;
      cursor += 1;
      if (state === "single-quote" && character === "'") state = "normal";
      else if (state === "double-quote" && character === '"') state = "normal";
      else if (state === "line-comment" && character === "\n") state = "normal";
      else if (state === "block-comment" && character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'" || character === '"' || (character === "-" && sql[cursor + 1] === "-") || (character === "/" && sql[cursor + 1] === "*")) {
      state = character === "'" ? "single-quote" : character === '"' ? "double-quote" : character === "-" ? "line-comment" : "block-comment";
      output += character === "'" || character === '"' ? character : sql.slice(cursor, cursor + 2);
      cursor += character === "'" || character === '"' ? 1 : 2;
      continue;
    }
    const call = cursor > 0 && (isIdentifierPart(sql[cursor - 1]!) || sql[cursor - 1] === ".")
      ? null
      : /^((?:public\.|scalius_compat\.)?(json_each(?:_jsonb)?))\(\s*\$(\d+)\s*\)/i.exec(sql.slice(cursor, cursor + 64));
    const count = call ? jsonElementCount(params[Number(call[3]) - 1]) : null;
    if (call === null || count === null) {
      output += character;
      cursor += 1;
      continue;
    }
    cursor += call[0].length;
    const next = readFollowingWord(sql, cursor);
    const aliased = next !== null ? !NOT_AN_ALIAS.has(next.normalized) : /^\s*"/.test(sql.slice(cursor, cursor + 64));
    output += `(SELECT * FROM ${call[0]} LIMIT ${count})${aliased ? "" : ` AS ${call[2]!.toLowerCase()}`}`;
  }
  return output;
}

/**
 * A JSON editor's bound value takes the JSON kind SQLite gives it: a safe
 * integer or a boolean is a number through `bigint`, any other number one
 * through `double precision`; a string or NULL stays an untyped parameter,
 * which PostgreSQL reads as text (a JSON string, or JSON null). Without the
 * values the kind is unknown: the statement is refused, never guessed.
 */
function typeJsonEditValues(sql: string, params: readonly unknown[] | undefined): string {
  if (!sql.includes(POSTGRES_JSON_VALUE_PARAMETER_HINT)) return sql;
  if (!params) throw new Error("A JSON editor's bound value is typed from its value: compile the statement with its bound values.");
  return sql.replaceAll(/\/\* scalius:json-value \*\/ \$(\d+)/g, (_hint, index: string) => {
    const value = params[Number(index) - 1];
    if (typeof value === "bigint" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) {
      return `$${index}::bigint`;
    }
    return typeof value === "number" ? `$${index}::double precision` : `$${index}`;
  });
}

/**
 * A JSON set read from a column or expression is a short list: the
 * compatibility table functions plan at 10 rows (`ROWS 10` in the bootstrap),
 * not PostgreSQL's default 1,000. 0151 sets it on an existing store.
 */
export const POSTGRES_JSON_EACH_ROWS_SQL = `DO $json_each_rows$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['public.json_each(text, text)', 'scalius_compat.json_each_jsonb(jsonb, text)', 'scalius_compat.json_each_jsonb(text, text)'] LOOP
    IF to_regprocedure(name) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s ROWS 10', to_regprocedure(name));
    END IF;
  END LOOP;
END
$json_each_rows$`;

/** Elements of a JSON array or object parameter, or null for anything else. */
function jsonElementCount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    return parsed !== null && typeof parsed === "object" ? Object.keys(parsed).length : null;
  } catch {
    return null;
  }
}

/** An identifier's first character, non-ASCII letters included (SQLite reads `é` as a name). */
function isWordStart(character: string): boolean {
  return /[\p{L}_$]/u.test(character);
}

function isWordPart(character: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(character);
}

/** Words after which an expression starts (so a following `+` is unary). */
const EXPRESSION_LEADING_WORDS = new Set([
  "and", "or", "not", "where", "on", "when", "then", "else", "select", "by", "set", "having",
  "case", "in", "is", "between", "like", "glob", "returning", "values", "distinct", "all",
  "limit", "offset", "return", "exists", "any", "some", "with", "as",
]);

/**
 * SQLite's unary `+` before a column (`+"orders"."status" = ?`) only keeps
 * the planner off that column's indexes; PostgreSQL has no unary plus for
 * text (`operator does not exist: + text`) and plans with statistics. A
 * unary `+` directly before a column reference (a bare or quoted identifier)
 * is dropped; a binary `a + b` and a unary plus before a number, parameter or
 * parenthesis stay. Quoted text and comments are opaque.
 */
export function compileSqliteUnaryPlusColumns(sql: string): string {
  let output = "";
  let cursor = 0;
  let state: ScannerState = "normal";
  /** Whether the previous significant token ends an operand (so a `+` after it is binary). */
  let afterOperand = false;

  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (state !== "normal") {
      output += character;
      cursor += 1;
      if (state === "single-quote" || state === "double-quote") {
        const quote = state === "single-quote" ? "'" : '"';
        if (character === quote && sql[cursor] === quote) {
          output += quote;
          cursor += 1;
        } else if (character === quote) {
          state = "normal";
          afterOperand = true;
        }
      } else if (state === "line-comment" && character === "\n") {
        state = "normal";
      } else if (state === "block-comment" && character === "*" && sql[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      state = character === "'" ? "single-quote" : "double-quote";
      output += character;
      cursor += 1;
      continue;
    }
    if (character === "-" && sql[cursor + 1] === "-") {
      state = "line-comment";
      output += "--";
      cursor += 2;
      continue;
    }
    if (character === "/" && sql[cursor + 1] === "*") {
      state = "block-comment";
      output += "/*";
      cursor += 2;
      continue;
    }
    if (/\s/.test(character)) {
      output += character;
      cursor += 1;
      continue;
    }
    if (character === "`" || character === "[") {
      // SQLite's other identifier quotes: one operand token.
      const close = character === "`" ? "`" : "]";
      let end = cursor + 1;
      while (end < sql.length) {
        if (sql[end] === close && close === "`" && sql[end + 1] === "`") end += 2;
        else if (sql[end] === close) break;
        else end += 1;
      }
      output += sql.slice(cursor, end + 1);
      cursor = end + 1;
      afterOperand = true;
      continue;
    }
    if (isWordStart(character)) {
      let end = cursor + 1;
      while (end < sql.length && isWordPart(sql[end]!)) end += 1;
      const word = sql.slice(cursor, end);
      afterOperand = !EXPRESSION_LEADING_WORDS.has(word.toLowerCase());
      output += word;
      cursor = end;
      continue;
    }
    if (/[0-9]/.test(character)) {
      let end = cursor + 1;
      while (end < sql.length && /[0-9.]/.test(sql[end]!)) end += 1;
      output += sql.slice(cursor, end);
      cursor = end;
      afterOperand = true;
      continue;
    }
    if (character === "+" && !afterOperand) {
      let next = cursor + 1;
      while (next < sql.length && /\s/.test(sql[next]!)) next += 1;
      const following = sql[next] ?? "";
      if (following === '"' || following === "`" || following === "[" || isWordStart(following)) {
        // `AND+x` must not become `ANDx`.
        if (isWordPart(output.at(-1) ?? "")) output += " ";
        cursor = next;
        continue;
      }
    }
    afterOperand = character === ")" || character === "?";
    output += character;
    cursor += 1;
  }
  return output;
}

/**
 * Compile one parameterized SQLite statement to PostgreSQL's wire syntax.
 * Values remain parameters; only trusted SQL generated by Drizzle/application
 * source is transformed. `parameters` is the bound values (or only their
 * count): a JSON editor's bound value is typed from its value, so a statement
 * with one compiles only with the values.
 */
export function compileSqliteStatementForPostgres(
  sqliteSql: string,
  parameters?: number | readonly unknown[],
): CompiledPostgresStatement {
  if (!sqliteSql.trim()) throw new Error("SQLite SQL statement must not be empty.");

  const source = compileSqliteConflictTargets(compileSqliteJsonExtractPaths(compileSqliteJsonObjects(
    compileSqliteJsonbEachHints(compileSqliteErrorSentinels(
      compileSqliteNullSafeComparisons(compileSqliteUnaryPlusColumns(sqliteSql)),
    )),
  )));

  let state: ScannerState = "normal";
  let cursor = 0;
  let parameterCount = 0;
  let placeholderStyle: "anonymous" | "indexed" | null = null;
  let previousWord = "";
  let previousWordWasAlias = false;
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
      previousWordWasAlias = false;
      output += character;
      cursor += 1;
      state = "single-quote";
      continue;
    }
    if (character === '"') {
      previousWord = "";
      previousWordWasAlias = false;
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
      previousWordWasAlias = false;
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
      previousWordWasAlias = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = cursor + 1;
      while (end < source.length && isIdentifierPart(source[end]!)) end += 1;
      const original = source.slice(cursor, end);
      const normalized = original.toLowerCase();
      // SQLite's access-path contract has no PostgreSQL equivalent. Accept
      // only AS <bare alias> INDEXED BY <bare index>; the existing scanner
      // keeps quoted text/identifiers and comments opaque. Other forms stay
      // unsupported instead of partially removing an unfamiliar clause.
      if (normalized === "indexed" && previousWordWasAlias) {
        const by = readFollowingWord(source, end);
        const index = by?.normalized === "by" ? readFollowingWord(source, by.end) : null;
        if (index) {
          cursor = index.end;
          previousWord = "";
          previousWordWasAlias = false;
          continue;
        }
      }
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
      previousWordWasAlias = previousWord === "as" && !POSTGRES_AS_SYNTAX_WORDS.has(normalized);
      previousWord = normalized;
      cursor = end;
      continue;
    }

    output += character;
    cursor += 1;
    if (!/\s/.test(character)) previousWordWasAlias = false;
    if (!/\s/.test(character) && character !== ".") previousWord = "";
  }

  if (state !== "normal" && state !== "line-comment") {
    throw new Error("SQLite SQL contains an unterminated literal or comment.");
  }
  const expectedParameterCount = typeof parameters === "number" ? parameters : parameters?.length;
  if (
    expectedParameterCount !== undefined
    && parameterCount !== expectedParameterCount
  ) {
    throw new Error(
      `SQLite SQL parameter count ${parameterCount} does not match ${expectedParameterCount}.`,
    );
  }

  return {
    sql: typeJsonEditValues(output, typeof parameters === "number" ? undefined : parameters),
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
 * SQLite's `json_array_length` and `json_each` on any JSON shape: a missing
 * path is NULL (`json_array_length`) or no rows (`json_each`), anything but
 * an array has length 0, and `json_each` over a scalar (JSON null included)
 * is one row with no key whose full key and path are the path. Part of the
 * bootstrap; migration 0190 installs the same text on an existing store
 * (its PostgreSQL file must contain it verbatim).
 */
export const POSTGRES_JSON_SHAPE_FUNCTIONS_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.json_array_length(input_text text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value) ELSE 0 END::bigint
  FROM (SELECT input_text::jsonb AS value) AS target
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_text text, json_path text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE
    WHEN target.value IS NULL THEN NULL
    WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value)
    ELSE 0
  END::bigint
  FROM (SELECT scalius_compat.json_path_value(input_text, json_path) AS value) AS target
$function$;

CREATE OR REPLACE FUNCTION public.json_array_length(input_json jsonb, json_path text DEFAULT '$')
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT CASE
    WHEN target.value IS NULL THEN NULL
    WHEN jsonb_typeof(target.value) = 'array' THEN jsonb_array_length(target.value)
    ELSE 0
  END::bigint
  FROM (SELECT scalius_compat.json_path_value(input_json, json_path) AS value) AS target
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
ROWS 10
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_text, json_path);
  IF target IS NULL THEN
    RETURN;
  ELSIF jsonb_typeof(target) = 'array' THEN
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
    RETURN QUERY
      SELECT
        NULL::text,
        scalius_compat.json_scalar_text(target),
        public.json_type(target::text),
        scalius_compat.json_scalar_text(target),
        0::bigint,
        NULL::bigint,
        json_path,
        json_path;
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
ROWS 10
AS $function$
DECLARE
  target jsonb;
BEGIN
  target := scalius_compat.json_path_value(input_json, json_path);
  IF target IS NULL THEN
    RETURN;
  ELSIF jsonb_typeof(target) = 'array' THEN
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
    RETURN QUERY
      SELECT
        NULL::text,
        target,
        public.json_type(target::text),
        scalius_compat.json_scalar_text(target),
        0::bigint,
        NULL::bigint,
        json_path,
        json_path;
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
ROWS 10
AS $function$
  SELECT * FROM scalius_compat.json_each_jsonb(input_text::jsonb, json_path)
$function$;
`;

/**
 * SQLite's JSON editors, `json_set`, `json_insert`, `json_replace` and
 * `json_remove`, with SQLite's answer for every path the document has or
 * lacks: set writes either way, insert only a missing member or the append
 * slot (`[#]`, the index one past the end), replace only an existing one;
 * missing parents are created as objects (`.name`) or one-element arrays
 * (`[0]`, `[#]`), and a path through a scalar, or an index past the append
 * slot, changes nothing. Paths take `.name`, `."quoted name"`, `[N]`, `[#]`
 * and `[#-N]`; any other path raises. A text value is a JSON string, a number
 * a number, a JSON value (`json()`, a constructor, `json_extract`) itself, SQL
 * NULL JSON null, a boolean 1 or 0. One path/value pair per call: the compiler
 * nests SQLite's longer calls, which apply their pairs left to right. The
 * result prints with PostgreSQL's key order and spacing; readers parse it.
 * Every function is PARALLEL SAFE and IMMUTABLE, except the overloads taking a
 * value of any type: STABLE, as `to_jsonb` is (a timestamp follows the
 * session's time zone). The value helper is `json_edit_value`, not
 * `json_value`, a SQL/JSON keyword from PostgreSQL 17.
 * Part of the bootstrap; migration 0195 installs the same text on an existing
 * store (its PostgreSQL file must contain it verbatim).
 */
export const POSTGRES_JSON_EDIT_FUNCTIONS_SQL = String.raw`
CREATE OR REPLACE FUNCTION scalius_compat.json_path_steps(json_path text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $function$
DECLARE
  steps text[] := ARRAY[]::text[];
  rest text;
  step text[];
BEGIN
  IF left(json_path, 1) <> '$' THEN
    RAISE EXCEPTION 'bad JSON path: %', quote_literal(json_path) USING ERRCODE = '22023';
  END IF;
  rest := substr(json_path, 2);
  WHILE rest <> '' LOOP
    step := regexp_match(rest, '^(\."([^"\\]*)"(?=$|[.[])|\.([^.["][^.[]*)|\[([0-9]+|#(?:-[0-9]+)?)\])');
    IF step IS NULL THEN
      RAISE EXCEPTION 'bad JSON path: %', quote_literal(json_path) USING ERRCODE = '22023';
    END IF;
    steps := steps || CASE WHEN step[4] IS NULL THEN '.' || coalesce(step[2], step[3]) ELSE '[' || step[4] END;
    rest := substr(rest, length(step[1]) + 1);
  END LOOP;
  RETURN steps;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_edit(target jsonb, steps text[], new_value jsonb, mode text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  step text := steps[1];
  rest text[] := steps[2:];
  location text[];
  child jsonb;
  empty jsonb;
  size bigint;
  position numeric;
BEGIN
  IF step IS NULL THEN
    RETURN CASE mode WHEN 'insert' THEN target WHEN 'remove' THEN NULL ELSE new_value END;
  END IF;
  IF left(step, 1) = '.' THEN
    IF jsonb_typeof(target) IS DISTINCT FROM 'object' THEN RETURN target; END IF;
    location := ARRAY[substr(step, 2)];
    child := target -> location[1];
  ELSE
    IF jsonb_typeof(target) IS DISTINCT FROM 'array' THEN RETURN target; END IF;
    size := jsonb_array_length(target);
    position := CASE WHEN substr(step, 2, 1) = '#'
      THEN size - coalesce(nullif(substr(step, 4), '')::numeric, 0)
      ELSE substr(step, 2)::numeric END;
    IF position < 0 OR position > size THEN RETURN target; END IF;
    location := ARRAY[position::text];
    child := target -> position::integer;
  END IF;
  IF child IS NOT NULL THEN
    IF mode = 'remove' AND rest = ARRAY[]::text[] THEN RETURN target #- location; END IF;
    RETURN jsonb_set(target, location, scalius_compat.json_edit(child, rest, new_value, mode));
  END IF;
  IF mode NOT IN ('set', 'insert') THEN RETURN target; END IF;
  IF rest = ARRAY[]::text[] THEN
    child := new_value;
  ELSE
    empty := CASE WHEN left(rest[1], 1) = '.' THEN '{}'::jsonb ELSE '[]'::jsonb END;
    child := scalius_compat.json_edit(empty, rest, new_value, mode);
    IF child = empty THEN RETURN target; END IF;
  END IF;
  RETURN CASE WHEN jsonb_typeof(target) = 'array'
    THEN target || jsonb_build_array(child)
    ELSE target || jsonb_build_object(location[1], child) END;
END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_edit_text(input_text text, json_path text, new_value jsonb, mode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN input_text IS NULL THEN NULL
    WHEN json_path IS NULL THEN input_text::jsonb::text
    ELSE scalius_compat.json_edit(
      input_text::jsonb,
      scalius_compat.json_path_steps(json_path),
      coalesce(new_value, 'null'::jsonb),
      mode
    )::text
  END
$function$;

CREATE OR REPLACE FUNCTION scalius_compat.json_edit_value(value anyelement)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN value IS NULL THEN 'null'::jsonb
    WHEN pg_typeof(value) = 'boolean'::regtype THEN to_jsonb(CASE WHEN value::text = 'true' THEN 1 ELSE 0 END)
    ELSE to_jsonb(value)
  END
$function$;

CREATE OR REPLACE FUNCTION public.json_set(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'set')
$function$;

CREATE OR REPLACE FUNCTION public.json_set(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_edit_value(value), 'set')
$function$;

CREATE OR REPLACE FUNCTION public.json_insert(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'insert')
$function$;

CREATE OR REPLACE FUNCTION public.json_insert(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_edit_value(value), 'insert')
$function$;

CREATE OR REPLACE FUNCTION public.json_replace(input_text text, json_path text, value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, to_jsonb(value), 'replace')
$function$;

CREATE OR REPLACE FUNCTION public.json_replace(input_text text, json_path text, value anyelement)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT scalius_compat.json_edit_text(input_text, json_path, scalius_compat.json_edit_value(value), 'replace')
$function$;

CREATE OR REPLACE FUNCTION public.json_remove(input_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $function$
  SELECT input_text::jsonb::text
$function$;

CREATE OR REPLACE FUNCTION public.json_remove(input_text text, VARIADIC json_paths text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  result jsonb;
  json_path text;
BEGIN
  IF input_text IS NULL OR json_paths IS NULL OR array_position(json_paths, NULL) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  result := input_text::jsonb;
  FOREACH json_path IN ARRAY json_paths LOOP
    result := scalius_compat.json_edit(result, scalius_compat.json_path_steps(json_path), NULL, 'remove');
    IF result IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN result::text;
END
$function$;
`;

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

${POSTGRES_JSON_SHAPE_FUNCTIONS_SQL}

${POSTGRES_JSON_EDIT_FUNCTIONS_SQL}

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

-- unixepoch(epoch, 'unixepoch', '+N days|months|years') with SQLite's
-- calendar rules: months and years keep the day of month and let it overflow
-- into the next month (Jan 31 + 1 month = Mar 3 in a common year), as the
-- warranty expiry trigger computes on D1/Turso.
CREATE OR REPLACE FUNCTION public.unixepoch(epoch_seconds bigint, modifier text, shift text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  parts text[];
  amount bigint;
  unit text;
  base_timestamp timestamp;
  total_months bigint;
  seconds_into_day bigint;
BEGIN
  IF lower(modifier) <> 'unixepoch' THEN
    RAISE EXCEPTION 'unsupported unixepoch() modifier: %', modifier USING ERRCODE = '22023';
  END IF;
  parts := regexp_match(shift, '^\s*([+-]?[0-9]+)\s+(days?|months?|years?)\s*$', 'i');
  IF parts IS NULL THEN
    RAISE EXCEPTION 'unsupported unixepoch() modifier: %', shift USING ERRCODE = '22023';
  END IF;
  amount := parts[1]::bigint;
  unit := lower(parts[2]);
  IF unit LIKE 'day%' THEN
    RETURN epoch_seconds + amount * 86400;
  END IF;
  IF unit LIKE 'year%' THEN
    amount := amount * 12;
  END IF;
  base_timestamp := to_timestamp(epoch_seconds) AT TIME ZONE 'UTC';
  total_months := extract(year FROM base_timestamp)::bigint * 12
    + extract(month FROM base_timestamp)::bigint - 1 + amount;
  seconds_into_day := epoch_seconds
    - floor(extract(epoch FROM date_trunc('day', base_timestamp) AT TIME ZONE 'UTC'))::bigint;
  RETURN floor(extract(epoch FROM make_timestamp(
      (total_months / 12)::integer, (total_months % 12 + 1)::integer, 1, 0, 0, 0
    ) AT TIME ZONE 'UTC'))::bigint
    + (extract(day FROM base_timestamp)::bigint - 1) * 86400
    + seconds_into_day;
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
