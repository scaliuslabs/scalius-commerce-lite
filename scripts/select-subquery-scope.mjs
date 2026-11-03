// Drizzle renders a column that is a direct chunk of a select-list SQL
// unqualified when the query has no join (and always in `returning`). Inside
// a subquery of that SQL the bare name binds to the subquery's own table when
// it has a column of that name: `(SELECT count(*) FROM product_option_values
// AS v WHERE v.option_definition_id = ${productOptionDefinitions.id})` counts
// rows whose option_definition_id equals their own id. This finds every such
// outer reference so it can be written with `qualifiedColumn()`.
//
// It follows what a select field really is: an inline sql`` template, a const,
// a helper call (its returned template, with the call's columns bound to its
// parameters), an object spread or a function returning the fields; tables
// under `alias()` or a renamed import; subqueries in a FROM clause.
//
//   node scripts/select-subquery-scope.mjs   lists the findings (exit 1 on any)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCANNED_DIRS = ["packages", "apps/api/src", "plugins"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", "generated", "testing"]);
const JOINS = new Set(["innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin", "join"]);
const SELECTS = new Set(["select", "selectDistinct", "returning"]);
const MAX_DEPTH = 5;
const SQL_WORDS = /^(WHERE|ON|INNER|LEFT|RIGHT|FULL|CROSS|JOIN|GROUP|ORDER|LIMIT|UNION|AND|OR|USING|NATURAL|WINDOW|HAVING|EXCEPT|INTERSECT)$/i;

/** Drizzle table variables of the schema, by variable name: their SQL names. */
export function readSchemaTables(root = ROOT) {
  const dir = path.join(root, "packages/database/src/schema");
  const tables = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const match of text.matchAll(/export const (\w+)\s*=\s*\w+\(\s*["'`](\w+)["'`]/g)) tables.set(match[1], match[2]);
  }
  return tables;
}

const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression?.(node) || ts.isTypeAssertionExpression?.(node))) node = node.expression;
  return node;
};
const isSqlTag = (node, source) =>
  ts.isTaggedTemplateExpression(node) && /^sql(<.*>)?$/s.test(node.tag.getText(source).replace(/\s/g, ""));

/** One parsed source file and what its names mean. */
function fileInfo(fileName, text, schemaTables) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const tables = new Map(); // local name -> { name, base }
  for (const [name, table] of schemaTables) tables.set(name, { name: table, base: table });
  const functions = new Map();
  const consts = new Map();
  for (const statement of source.statements) {
    // `import { orders as orderTable } from "@scalius/database/schema"` (any module re-exporting a schema table)
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (schemaTables.has(imported)) tables.set(element.name.text, { name: schemaTables.get(imported), base: schemaTables.get(imported) });
        }
      }
    }
  }
  const collect = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(node.name.text, init);
      // `const terminal = alias(inventoryMovements, "terminal")`
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "alias"
        && init.arguments.length >= 2 && ts.isStringLiteralLike(init.arguments[1])) {
        const base = ts.isIdentifier(init.arguments[0]) ? tables.get(init.arguments[0].text) : undefined;
        if (base) tables.set(node.name.text, { name: init.arguments[1].text, base: base.base });
      }
      if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return { fileName, source, tables, functions, consts };
}

/** Every function's returned expressions (not those of nested functions). */
function returnedExpressions(fn) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return out;
}

class Analyzer {
  constructor(files) {
    this.files = files;
    this.byName = new Map();
    for (const info of files) {
      for (const [name, fn] of info.functions) {
        if (!this.byName.has(name)) this.byName.set(name, []);
        this.byName.get(name).push({ info, fn });
      }
    }
  }

  /** The function(s) a callee name means: the file's own, else every declaration of that name. */
  resolve(name, info) {
    const own = info.functions.get(name);
    return own ? [{ info, fn: own }] : this.byName.get(name) ?? [];
  }

  /** What an expression is: a table, a column, or anything else. */
  value(expr, ctx, depth = 0) {
    expr = unwrap(expr);
    if (!expr || depth > MAX_DEPTH) return { kind: "other" };
    if (ts.isIdentifier(expr)) {
      if (ctx.env.has(expr.text)) return ctx.env.get(expr.text);
      const table = ctx.info.tables.get(expr.text);
      if (table) return { kind: "table", ...table };
      const init = ctx.info.consts.get(expr.text);
      if (init && !ctx.seen.has(init)) return this.value(init, { ...ctx, seen: new Set([...ctx.seen, init]) }, depth + 1);
      return { kind: "other" };
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = this.value(expr.expression, ctx, depth + 1);
      if (owner.kind === "table") return { kind: "column", name: owner.name, text: expr.getText(ctx.info.source) };
    }
    return { kind: "other" };
  }

  /** The sql`` templates a select field renders as (with the bindings in force). */
  fieldTemplates(expr, ctx, depth = 0) {
    expr = unwrap(expr);
    if (!expr || depth > MAX_DEPTH) return [];
    if (isSqlTag(expr, ctx.info.source)) return [{ template: expr.template, ctx }];
    if (ts.isConditionalExpression(expr)) return [...this.fieldTemplates(expr.whenTrue, ctx, depth + 1), ...this.fieldTemplates(expr.whenFalse, ctx, depth + 1)];
    if (ts.isIdentifier(expr)) {
      if (ctx.env.has(expr.text)) return [];
      const init = ctx.info.consts.get(expr.text);
      return init && !ctx.seen.has(init) ? this.fieldTemplates(init, { ...ctx, seen: new Set([...ctx.seen, init]) }, depth + 1) : [];
    }
    if (ts.isCallExpression(expr)) {
      const callee = unwrap(expr.expression);
      if (ts.isPropertyAccessExpression(callee) && ["as", "mapWith"].includes(callee.name.text)) return this.fieldTemplates(callee.expression, ctx, depth + 1);
      if (ts.isIdentifier(callee)) return this.call(callee.text, expr.arguments, ctx, depth, (ret, inner) => this.fieldTemplates(ret, inner, depth + 1));
    }
    return [];
  }

  /** The fields of a select argument: object literals, spreads, consts and helper calls. */
  fields(expr, ctx, depth = 0) {
    expr = unwrap(expr);
    if (!expr || depth > MAX_DEPTH) return [];
    if (ts.isObjectLiteralExpression(expr)) {
      const out = [];
      for (const property of expr.properties) {
        if (ts.isPropertyAssignment(property)) out.push({ name: property.name.getText(ctx.info.source), expr: property.initializer, ctx, at: property });
        else if (ts.isShorthandPropertyAssignment(property)) out.push({ name: property.name.text, expr: property.name, ctx, at: property });
        else if (ts.isSpreadAssignment(property)) out.push(...this.fields(property.expression, ctx, depth + 1));
      }
      return out;
    }
    if (ts.isConditionalExpression(expr)) return [...this.fields(expr.whenTrue, ctx, depth + 1), ...this.fields(expr.whenFalse, ctx, depth + 1)];
    if (ts.isIdentifier(expr)) {
      const init = ctx.info.consts.get(expr.text);
      return init && !ctx.seen.has(init) ? this.fields(init, { ...ctx, seen: new Set([...ctx.seen, init]) }, depth + 1) : [];
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(unwrap(expr.expression))) {
      return this.call(unwrap(expr.expression).text, expr.arguments, ctx, depth, (ret, inner) => this.fields(ret, inner, depth + 1));
    }
    return [];
  }

  /** Follows a helper call: its parameters bound to the call's arguments, through each of its returns. */
  call(name, args, ctx, depth, follow) {
    if (["sql", "eq", "and", "or", "not", "count", "sum", "max", "min", "avg", "countDistinct", "coalesce", "alias"].includes(name)) return [];
    const out = [];
    for (const { info, fn } of this.resolve(name, ctx.info)) {
      if (ctx.stack.includes(fn)) continue;
      const env = new Map();
      const inner = { info, env, seen: new Set(), stack: [...ctx.stack, fn] };
      fn.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        // An omitted argument takes the parameter's default, read in the helper's own file.
        const value = index < args.length ? this.value(args[index], ctx)
          : parameter.initializer ? this.value(parameter.initializer, inner) : { kind: "other" };
        env.set(parameter.name.text, value);
      });
      for (const ret of returnedExpressions(fn)) out.push(...follow(ret, inner));
    }
    return out;
  }

  /** The outer references of one template: a direct column chunk that a subquery's own FROM does not own. */
  outerReferences(template, ctx) {
    if (!ts.isTemplateExpression(template)) return [];
    let text = template.head.text;
    const refs = [];
    for (const span of template.templateSpans) {
      const value = this.value(span.expression, ctx);
      if (value.kind === "table") text += value.name === value.base ? ` "${value.base}" ` : ` "${value.base}" "${value.name}" `;
      else if (value.kind === "column") { refs.push({ at: text.length, name: value.name, text: value.text }); text += " ? "; }
      else text += " ? ";
      text += span.literal.text;
    }
    return scopeFindings(text, refs);
  }
}

/** Refs that sit in a subquery whose own FROM does not name their table unaliased. */
export function scopeFindings(text, refs) {
  const scopes = [{ start: 0, end: text.length, parent: null }];
  const stack = [scopes[0]];
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") {
      const scope = { start: index + 1, end: text.length, parent: stack.at(-1) };
      scopes.push(scope);
      stack.push(scope);
    } else if (char === ")" && stack.length > 1) {
      stack.pop().end = index;
    }
  }
  for (const scope of scopes) {
    const own = text.slice(scope.start, scope.end).split("");
    for (const inner of scopes) {
      if (inner.parent !== scope) continue;
      for (let index = inner.start; index < inner.end; index += 1) own[index - scope.start] = " ";
    }
    const ownText = own.join("");
    scope.tables = [];
    for (const match of ownText.matchAll(/\b(?:FROM|JOIN)\s+"?([A-Za-z_]\w*)"?/gi)) {
      const alias = /^\s+(?:AS\s+)?"?([A-Za-z_]\w*)"?/i.exec(ownText.slice(match.index + match[0].length))?.[1];
      scope.tables.push({ name: alias && !SQL_WORDS.test(alias) ? alias : match[1] });
    }
    // A subquery in the FROM clause: its alias names it.
    for (const match of ownText.matchAll(/\b(?:FROM|JOIN)\s*\(\s*\)\s*(?:AS\s+)?"?([A-Za-z_]\w*)?"?/gi)) {
      scope.tables.push({ name: match[1] && !SQL_WORDS.test(match[1]) ? match[1] : "(derived)" });
    }
  }
  const findings = [];
  for (const ref of refs) {
    let scope = scopes.filter((candidate) => candidate.start <= ref.at && ref.at <= candidate.end)
      .sort((left, right) => right.start - left.start)[0];
    while (scope && scope.tables.length === 0) scope = scope.parent;
    // At the top level the bare name binds to the query's own table.
    if (!scope || scope.parent === null) continue;
    if (scope.tables.some((entry) => entry.name === ref.name)) continue;
    findings.push(ref.text);
  }
  return [...new Set(findings)];
}

/** Whether the enclosing function joins onto the query held in `name`. */
function joinedLater(name, node) {
  let scope = node.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let found = false;
  const rootOf = (expression) => {
    while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) expression = expression.expression;
    return expression;
  };
  const visit = (current) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(current) && JOINS.has(current.name.text)) {
      const root = rootOf(current.expression);
      if (ts.isIdentifier(root) && root.text === name) found = true;
    }
    ts.forEachChild(current, visit);
  };
  if (scope) visit(scope);
  return found;
}

/** Every finding of the given parsed files: the select site, the field and where the template is. */
export function scanFiles(infos) {
  const analyzer = new Analyzer(infos);
  const findings = [];
  for (const info of infos) {
    if (!/\.(select|selectDistinct|returning)\(/.test(info.source.text)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && SELECTS.has(node.expression.name.text) && node.arguments[0]) {
        let joined = false;
        let chain = node;
        for (; chain.parent && (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent)); chain = chain.parent) {
          if (ts.isPropertyAccessExpression(chain.parent) && JOINS.has(chain.parent.name.text)) joined = true;
        }
        // A query kept in a variable (`$dynamic()`) and joined later in the same function.
        const holder = chain.parent && ts.isVariableDeclaration(chain.parent) && ts.isIdentifier(chain.parent.name) ? chain.parent.name.text
          : chain.parent && ts.isBinaryExpression(chain.parent) && ts.isIdentifier(chain.parent.left) ? chain.parent.left.text : null;
        if (!joined && holder) joined = joinedLater(holder, node);
        if (node.expression.name.text === "returning" || !joined) {
          const ctx = { info, env: new Map(), seen: new Set(), stack: [] };
          for (const field of analyzer.fields(node.arguments[0], ctx)) {
            for (const { template, ctx: inner } of analyzer.fieldTemplates(field.expr, field.ctx)) {
              const refs = analyzer.outerReferences(template, inner);
              if (refs.length === 0) continue;
              // The field's own line when it is written here, else the select call's.
              const at = field.at.getSourceFile() === info.source ? field.at : node;
              const site = info.source.getLineAndCharacterOfPosition(at.getStart(info.source));
              const origin = inner.info.source.getLineAndCharacterOfPosition(template.getStart(inner.info.source));
              findings.push({
                file: info.fileName, line: site.line + 1, field: field.name, refs,
                origin: `${inner.info.fileName}:${origin.line + 1}`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.source);
  }
  const unique = new Map(findings.map((finding) => [`${finding.file}:${finding.line} ${finding.field} ${finding.origin} ${finding.refs.join(",")}`, finding]));
  return [...unique.values()];
}

/** Findings of one or more in-memory sources (fixtures): `{ fileName: text }`. */
export function scanSources(sources, schemaTables = readSchemaTables()) {
  return scanFiles(Object.entries(sources).map(([fileName, text]) => fileInfo(fileName, text, schemaTables)));
}

/** The findings of the whole repository's production sources. */
export function scanRepository(root = ROOT, dirs = SCANNED_DIRS) {
  const schemaTables = readSchemaTables(root);
  const infos = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$|\.test\.|\.invariant\.ts$/.test(entry.name)) {
        infos.push(fileInfo(path.relative(root, full), fs.readFileSync(full, "utf8"), schemaTables));
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return scanFiles(infos);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  for (const finding of findings) console.log(`${finding.file}:${finding.line} ${finding.field}: ${finding.refs.join(" ")} (template ${finding.origin})`);
  process.exit(findings.length > 0 ? 1 : 0);
}
