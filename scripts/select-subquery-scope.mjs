// Drizzle renders a column that is a direct chunk of a select-list SQL
// unqualified when the query has no join (and always in `returning`). Inside
// a subquery of that SQL the bare name binds to the subquery's own table when
// it has a column of that name: `(SELECT count(*) FROM product_option_values
// AS v WHERE v.option_definition_id = ${productOptionDefinitions.id})` counts
// rows whose option_definition_id equals their own id. This finds every such
// outer reference so it can be written with `qualifiedColumn()`.
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

const isSqlTag = (node, source) =>
  ts.isTaggedTemplateExpression(node) && /^sql(<.*>)?$/s.test(node.tag.getText(source).replace(/\s/g, ""));

/** The tagged template a select field is, through `.as()`, `.mapWith()`, casts and same-file consts. */
function selectFieldTemplate(expression, source, consts, depth = 0) {
  if (!expression || depth > 4) return null;
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return selectFieldTemplate(expression.expression, source, consts, depth + 1);
  if (isSqlTag(expression, source)) return expression;
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && ["as", "mapWith"].includes(expression.expression.name.text)) {
    return selectFieldTemplate(expression.expression.expression, source, consts, depth + 1);
  }
  if (ts.isIdentifier(expression) && consts.has(expression.text)) return selectFieldTemplate(consts.get(expression.text), source, consts, depth + 1);
  return null;
}

/**
 * The outer references of one select-field template: a direct `${table.column}`
 * that sits inside a subquery whose own FROM does not name that table
 * unaliased. Nested sql`` values stay qualified, so only direct chunks count.
 */
export function outerReferences(template, source, tables) {
  if (!ts.isTemplateExpression(template)) return [];
  let text = template.head.text;
  const refs = [];
  for (const span of template.templateSpans) {
    const expression = span.expression;
    if (ts.isIdentifier(expression) && tables.has(expression.text)) {
      text += ` "${tables.get(expression.text)}" `;
    } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && tables.has(expression.expression.text)) {
      refs.push({ at: text.length, table: tables.get(expression.expression.text), text: expression.getText(source) });
      text += " ? ";
    } else {
      text += " ? ";
    }
    text += span.literal.text;
  }
  // Parenthesis scopes, ignoring quoted strings.
  const scopes = [{ start: 0, end: text.length, parent: null }];
  const stack = [scopes[0]];
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'") { quote = char; continue; }
    if (char === "(") {
      const scope = { start: index + 1, end: text.length, parent: stack.at(-1) };
      scopes.push(scope);
      stack.push(scope);
    } else if (char === ")" && stack.length > 1) {
      stack.pop().end = index;
    }
  }
  for (const scope of scopes) {
    // The scope's own text, its nested scopes blanked out.
    let own = text.slice(scope.start, scope.end).split("");
    for (const inner of scopes) {
      if (inner.parent !== scope) continue;
      for (let index = inner.start; index < inner.end; index += 1) own[index - scope.start] = " ";
    }
    own = own.join("");
    scope.tables = [...own.matchAll(/\b(?:FROM|JOIN)\s+"?([A-Za-z_]\w*)"?/gi)].map((match) => {
      // The word after the table, if it is an alias (read without consuming it).
      const alias = /^\s+(?:AS\s+)?"?([A-Za-z_]\w*)"?/i.exec(own.slice(match.index + match[0].length))?.[1];
      return {
        table: match[1],
        aliased: Boolean(alias) && !/^(WHERE|ON|INNER|LEFT|CROSS|JOIN|GROUP|ORDER|LIMIT|UNION|AND|OR|USING|NATURAL|WINDOW|HAVING)$/i.test(alias) && alias !== match[1],
      };
    });
  }
  const findings = [];
  for (const ref of refs) {
    let scope = scopes.filter((candidate) => candidate.start <= ref.at && ref.at <= candidate.end)
      .sort((left, right) => right.start - left.start)[0];
    while (scope && scope.tables.length === 0) scope = scope.parent;
    // At the top level the bare name binds to the query's own table.
    if (!scope || scope.parent === null) continue;
    if (scope.tables.some((entry) => entry.table === ref.table && !entry.aliased)) continue;
    findings.push(ref.text);
  }
  return [...new Set(findings)];
}

/** Every finding of one source file: `file:line field: refs`. */
export function scanSource(fileName, text, tables) {
  if (!/\.(select|selectDistinct|returning)\(/.test(text)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const consts = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) consts.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["select", "selectDistinct", "returning"].includes(node.expression.name.text)) {
      let fields = node.arguments[0];
      if (fields && ts.isIdentifier(fields) && consts.has(fields.text)) fields = consts.get(fields.text);
      let joined = false;
      for (let chain = node; chain.parent && (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent)); chain = chain.parent) {
        if (ts.isPropertyAccessExpression(chain.parent) && JOINS.has(chain.parent.name.text)) joined = true;
      }
      if (fields && ts.isObjectLiteralExpression(fields) && (node.expression.name.text === "returning" || !joined)) {
        for (const property of fields.properties) {
          const value = ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : null;
          const template = selectFieldTemplate(value, source, consts);
          if (!template) continue;
          const refs = outerReferences(template.template, source, tables);
          if (refs.length === 0) continue;
          const { line } = source.getLineAndCharacterOfPosition(property.getStart(source));
          findings.push({ file: fileName, line: line + 1, field: property.name.getText(source), refs });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** The findings of the whole repository's production sources. */
export function scanRepository(root = ROOT, dirs = SCANNED_DIRS) {
  const tables = readSchemaTables(root);
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$|\.test\.|\.invariant\.ts$/.test(entry.name)) {
        findings.push(...scanSource(path.relative(root, full), fs.readFileSync(full, "utf8"), tables));
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository();
  for (const finding of findings) console.log(`${finding.file}:${finding.line} ${finding.field}: ${finding.refs.join(" ")}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
