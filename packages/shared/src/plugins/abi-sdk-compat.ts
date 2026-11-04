// The SDK seal reads emitted declarations, not implementation text. Existing
// declarations are invariant: a type can be both an app input and a host output.
// New exports, overloads and optional object members (also in a function's
// result type) are additive, as is a constant's declared type gaining top-level
// keys or trailing top-level readonly-tuple entries (apps read a constant,
// never make one); everything nested in a constant is invariant.
// Retyping an existing signature requires the same explicit acknowledgement as
// the JSON ABI.
import ts from "typescript";

interface SdkSnapshot {
  exports: unknown;
  files: Map<string, ts.SourceFile>;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node: ts.Node, source: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, source).trim();

function parseSnapshot(text: string): SdkSnapshot {
  const sections = text.split(/^\/\/ (packages\/[^\n]+\.d\.ts)\n/gm);
  if (sections.length < 3 || !sections[0]!.startsWith("// Public exports\n")) {
    throw new Error("The SDK declaration snapshot is malformed.");
  }
  const files = new Map<string, ts.SourceFile>();
  for (let i = 1; i < sections.length; i += 2) {
    const path = sections[i]!;
    if (files.has(path)) throw new Error(`Duplicate SDK declaration file: ${path}`);
    files.set(path, ts.createSourceFile(path, sections[i + 1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => files.get(path);
  const diagnostics = ts.createProgram([...files.keys()], options, host).getSyntacticDiagnostics();
  if (diagnostics.length) throw new Error("The SDK declaration snapshot contains malformed TypeScript.");
  return { exports: JSON.parse(sections[0]!.slice("// Public exports\n".length)), files };
}

function retainedExports(before: unknown, after: unknown, path: string, problems: string[]): void {
  if (before !== null && typeof before === "object" && !Array.isArray(before)) {
    if (after === null || typeof after !== "object" || Array.isArray(after)) {
      problems.push(`${path}: the export map changed.`);
      return;
    }
    const now = after as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) {
      if (!(key in now)) problems.push(`${path}.${key}: the export was removed.`);
      else retainedExports(value, now[key], `${path}.${key}`, problems);
    }
  } else if (before !== after) problems.push(`${path}: the export target changed.`);
}

interface Declaration {
  node: ts.Node;
  text: string;
}

/** Split grouped exports/imports/variables so adding a name never changes an old name. */
function declarations(source: ts.SourceFile): Map<string, Declaration[]> {
  const result = new Map<string, Declaration[]>();
  const add = (name: string, node: ts.Node, text = print(node, source)) => {
    result.set(name, [...(result.get(name) ?? []), { node, text }]);
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const entry of statement.exportClause.elements) {
        add(`export:${entry.name.text}`, entry,
          `${statement.isTypeOnly ? "type " : ""}${print(entry, source)} from ${statement.moduleSpecifier ? print(statement.moduleSpecifier, source) : "local"}`);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      const prefix = `${clause.isTypeOnly ? "type " : ""}from ${print(statement.moduleSpecifier, source)} `;
      if (clause.name) add(`import:${clause.name.text}`, clause.name, `${prefix}default`);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const entry of clause.namedBindings.elements) add(`import:${entry.name.text}`, entry, prefix + print(entry, source));
      } else if (clause.namedBindings) {
        add(`import:${clause.namedBindings.name.text}`, clause.namedBindings, prefix + print(clause.namedBindings, source));
      }
    } else if (ts.isVariableStatement(statement)) {
      const prefix = `${statement.modifiers?.map((node) => print(node, source)).join(" ") ?? ""} ${statement.declarationList.flags}`;
      for (const entry of statement.declarationList.declarations) add(`variable:${print(entry.name, source)}`, entry, `${prefix} ${print(entry, source)}`);
    } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
      add(`${ts.SyntaxKind[statement.kind]}:${(statement.name as ts.Identifier).text}`, statement);
    } else {
      // Export-star, global augmentation and otherwise anonymous declarations
      // are kept verbatim; additions remain harmless separate declarations.
      add(print(statement, source), statement);
    }
  }
  return result;
}

function memberKey(member: ts.TypeElement, source: ts.SourceFile): string {
  return member.name ? print(member.name, source) : print(member, source);
}

/**
 * A type apps may construct (an interface, a type alias, a function's result)
 * gains optional members only, at any depth.
 */
function compatibleMembers(
  before: readonly ts.TypeElement[], after: readonly ts.TypeElement[],
  oldSource: ts.SourceFile, newSource: ts.SourceFile,
): boolean {
  const existing = new Set(before.map((member) => memberKey(member, oldSource)));
  for (const member of before) {
    const candidates = after.filter((next) => memberKey(next, newSource) === memberKey(member, oldSource));
    if (!candidates.some((next) => {
      if (print(member, oldSource) === print(next, newSource)) return true;
      if (!ts.isPropertySignature(member) || !ts.isPropertySignature(next)) return false;
      const header = (node: ts.PropertySignature, source: ts.SourceFile) => print(
        ts.factory.updatePropertySignature(node, node.modifiers, node.name, node.questionToken, undefined), source,
      );
      return header(member, oldSource) === header(next, newSource)
        && compatibleType(member.type, next.type, oldSource, newSource);
    })) return false;
  }
  // A new required member breaks apps that construct the public type.
  return after.every((member) => existing.has(memberKey(member, newSource)) || !!member.questionToken);
}

/**
 * A type printed with every union's members, and every object type's
 * properties, in one order. TypeScript prints both in the order it happened
 * to create their types, which unrelated code can change (a new literal
 * `"failed"` elsewhere reorders `"unknown" | "failed"`); neither order means
 * anything. Tuples, parameters and overloads keep theirs. A list's members
 * (`(typeof LIST)[number]`, LIST a `declare const` readonly tuple of the
 * same file) read as the union they are, so a union may become a list that
 * then grows at its end.
 */
function canonical(node: ts.TypeNode, source: ts.SourceFile): string {
  const listMembers = (name: string): readonly ts.TypeNode[] | null => {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((entry) => ts.isIdentifier(entry.name) && entry.name.text === name);
      if (declaration?.type) return readonlyTuple(declaration.type);
    }
    return null;
  };
  const result = ts.transform(node, [(context) => (root) => {
    const byText = (a: ts.Node, b: ts.Node) => print(a, source).localeCompare(print(b, source));
    const visit = (child: ts.Node): ts.Node => {
      if (ts.isIndexedAccessTypeNode(child) && child.indexType.kind === ts.SyntaxKind.NumberKeyword) {
        const object = ts.isParenthesizedTypeNode(child.objectType) ? child.objectType.type : child.objectType;
        const members = ts.isTypeQueryNode(object) && ts.isIdentifier(object.exprName) ? listMembers(object.exprName.text) : null;
        if (members?.length) return visit(context.factory.createUnionTypeNode(members));
      }
      const next = ts.visitEachChild(child, visit, context);
      if (ts.isUnionTypeNode(next)) return context.factory.updateUnionTypeNode(next, context.factory.createNodeArray([...next.types].sort(byText)));
      if (ts.isTypeLiteralNode(next) && next.members.every(ts.isPropertySignature)) {
        return context.factory.updateTypeLiteralNode(next, context.factory.createNodeArray([...next.members].sort(byText)));
      }
      return next;
    };
    return ts.visitNode(root, visit) as ts.TypeNode;
  }]);
  try {
    return print(result.transformed[0]!, source);
  } finally {
    result.dispose();
  }
}

function unparenthesized(node: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(node) ? unparenthesized(node.type) : node;
}

/** A union's literal members as text (`"a" | "b"`); null when any member is not a string literal. */
function stringLiterals(node: ts.TypeNode): string[] | null {
  const inner = unparenthesized(node);
  const members = ts.isUnionTypeNode(inner) ? inner.types.map(unparenthesized) : [inner];
  const values: string[] = [];
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    values.push(member.literal.text);
  }
  return values;
}

/** `{ prop: "a" | "b" } & rest…`: a discriminant literal, then the rest of the intersection. */
function discriminated(node: ts.TypeNode, source: ts.SourceFile): { key: string; values: string[]; rest: readonly ts.TypeNode[] } | null {
  const inner = unparenthesized(node);
  if (!ts.isIntersectionTypeNode(inner) || inner.types.length < 2) return null;
  const first = unparenthesized(inner.types[0]!);
  if (!ts.isTypeLiteralNode(first) || first.members.length !== 1) return null;
  const member = first.members[0]!;
  if (!ts.isPropertySignature(member) || member.questionToken || !member.type) return null;
  const values = stringLiterals(member.type);
  return values ? { key: memberKey(member, source), values, rest: inner.types.slice(1) } : null;
}

function compatibleTypeLists(
  before: readonly ts.TypeNode[], after: readonly ts.TypeNode[], oldSource: ts.SourceFile, newSource: ts.SourceFile,
): boolean {
  return before.length === after.length && before.every((node, index) => compatibleType(node, after[index], oldSource, newSource));
}

/**
 * A union keeps every member (each may grow, in any order) and gains none,
 * because a host that returns the type would hand apps a member they never
 * handled. One exception: a member discriminated by a string literal union
 * (`{ kind: "a" | "b" } & rest`) may be split into members that partition
 * those literals exactly, each keeping `rest` (and so able to grow it): every
 * old value still belongs to exactly one new member.
 */
function compatibleUnion(
  before: readonly ts.TypeNode[], after: readonly ts.TypeNode[], oldSource: ts.SourceFile, newSource: ts.SourceFile,
): boolean {
  const unmatchedBefore = before.filter((old) => !after.some((next) => compatibleType(old, next, oldSource, newSource)));
  const unmatchedAfter = after.filter((next) => !before.some((old) => compatibleType(old, next, oldSource, newSource)));
  const claimed = new Set<ts.TypeNode>();
  for (const old of unmatchedBefore) {
    const was = discriminated(old, oldSource);
    if (!was) return false;
    const parts = unmatchedAfter.filter((next) => {
      const now = discriminated(next, newSource);
      return now !== null && now.key === was.key && now.values.every((value) => was.values.includes(value))
        && compatibleTypeLists(was.rest, now.rest, oldSource, newSource);
    });
    const covered = parts.flatMap((next) => discriminated(next, newSource)!.values);
    if (covered.length !== was.values.length || new Set(covered).size !== was.values.length) return false;
    for (const part of parts) claimed.add(part);
  }
  return unmatchedAfter.every((next) => claimed.has(next));
}

/**
 * The same type, or one that only grows where apps cannot notice: an object
 * literal gains optional members, and that holds inside a union member, an
 * intersection member (same arity), an array's elements and parentheses, at
 * any depth. A removed or narrowed union member, a new required member and a
 * different primitive stay breaks.
 */
function compatibleType(
  before: ts.TypeNode | undefined, after: ts.TypeNode | undefined,
  oldSource: ts.SourceFile, newSource: ts.SourceFile,
): boolean {
  if (!before || !after) return before === after;
  if (print(before, oldSource) === print(after, newSource)) return true;
  if (canonical(before, oldSource) === canonical(after, newSource)) return true;
  const was = unparenthesized(before);
  const now = unparenthesized(after);
  if (ts.isTypeLiteralNode(was) && ts.isTypeLiteralNode(now)) return compatibleMembers(was.members, now.members, oldSource, newSource);
  if (ts.isArrayTypeNode(was) && ts.isArrayTypeNode(now)) return compatibleType(was.elementType, now.elementType, oldSource, newSource);
  if (ts.isUnionTypeNode(was) && ts.isUnionTypeNode(now)) return compatibleUnion(was.types, now.types, oldSource, newSource);
  if (ts.isIntersectionTypeNode(was) && ts.isIntersectionTypeNode(now)) return compatibleTypeLists(was.types, now.types, oldSource, newSource);
  return false;
}

/** A readonly tuple's elements (`readonly [a, b]`); null for any other type. */
function readonlyTuple(node: ts.TypeNode): readonly ts.TypeNode[] | null {
  return ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isTupleTypeNode(node.type)
    ? node.type.elements
    : null;
}

/**
 * A constant's declared type (`declare const X: …`), a value the host makes
 * and an app only reads, grows only at its top level: a readonly tuple keeps
 * every member in its place and may gain trailing ones (a new list entry), an
 * object type keeps every member exactly and may gain new ones (a new key).
 * Every nested member is invariant: a list or object inside a constant (a
 * port's required operations) never grows silently.
 */
function compatibleConstantType(before: ts.TypeNode, after: ts.TypeNode, oldSource: ts.SourceFile, newSource: ts.SourceFile): boolean {
  if (print(before, oldSource) === print(after, newSource)) return true;
  const oldTuple = readonlyTuple(before);
  const newTuple = oldTuple ? readonlyTuple(after) : null;
  if (oldTuple && newTuple) {
    return newTuple.length >= oldTuple.length
      && oldTuple.every((element, index) => print(element, oldSource) === print(newTuple[index]!, newSource));
  }
  if (ts.isTypeLiteralNode(before) && ts.isTypeLiteralNode(after)) {
    return before.members.every((member) => after.members.some((next) =>
      memberKey(next, newSource) === memberKey(member, oldSource) && print(next, newSource) === print(member, oldSource)));
  }
  return false;
}

function compatibleDeclaration(before: Declaration, after: Declaration, oldSource: ts.SourceFile, newSource: ts.SourceFile): boolean {
  if (before.text === after.text) return true;
  const oldNode = before.node;
  const newNode = after.node;
  if (ts.isInterfaceDeclaration(oldNode) && ts.isInterfaceDeclaration(newNode)) {
    const header = (node: ts.InterfaceDeclaration, source: ts.SourceFile) => print(
      ts.factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, []), source,
    );
    return header(oldNode, oldSource) === header(newNode, newSource)
      && compatibleMembers(oldNode.members, newNode.members, oldSource, newSource);
  }
  if (ts.isTypeAliasDeclaration(oldNode) && ts.isTypeAliasDeclaration(newNode)) {
    const header = (node: ts.TypeAliasDeclaration, source: ts.SourceFile) => print(
      ts.factory.updateTypeAliasDeclaration(node, node.modifiers, node.name, node.typeParameters, ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)), source,
    );
    return header(oldNode, oldSource) === header(newNode, newSource)
      && compatibleType(oldNode.type, newNode.type, oldSource, newSource);
  }
  // A constant keeps its modifiers and name; its declared type grows only at the top level.
  if (ts.isVariableDeclaration(oldNode) && ts.isVariableDeclaration(newNode) && oldNode.type && newNode.type && !oldNode.initializer && !newNode.initializer) {
    const prefix = (declaration: Declaration, node: ts.VariableDeclaration, source: ts.SourceFile) =>
      declaration.text.slice(0, declaration.text.length - print(node, source).length) + print(node.name, source);
    return prefix(before, oldNode, oldSource) === prefix(after, newNode, newSource)
      && compatibleConstantType(oldNode.type, newNode.type, oldSource, newSource);
  }
  // A function keeps its modifiers, name, type parameters and parameters; its result may gain optional members.
  if (ts.isFunctionDeclaration(oldNode) && ts.isFunctionDeclaration(newNode) && oldNode.type && newNode.type) {
    const header = (node: ts.FunctionDeclaration, source: ts.SourceFile) => print(
      ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, undefined, node.body), source,
    );
    return header(oldNode, oldSource) === header(newNode, newSource)
      && compatibleType(oldNode.type, newNode.type, oldSource, newSource);
  }
  return false;
}

/** Conservative structural compatibility of the emitted public SDK surface. */
export function sdkBreakingChanges(before: string, after: string): string[] {
  const was = parseSnapshot(before);
  const now = parseSnapshot(after);
  const problems: string[] = [];
  retainedExports(was.exports, now.exports, "sdk", problems);
  for (const [file, oldSource] of was.files) {
    const newSource = now.files.get(file);
    if (!newSource) {
      problems.push(`sdk.${file}: the declaration file was removed.`);
      continue;
    }
    const current = declarations(newSource);
    for (const [name, previous] of declarations(oldSource)) {
      const candidates = current.get(name);
      if (!candidates) problems.push(`sdk.${file}#${name}: the declaration was removed.`);
      else if (!previous.every((declaration) => candidates.some((candidate) => compatibleDeclaration(declaration, candidate, oldSource, newSource)))) {
        problems.push(`sdk.${file}#${name}: an existing signature changed or gained a required member.`);
      }
    }
  }
  return problems;
}

/** Always validate before a writer that may accept snapshot updates is invoked. */
export async function sealSdkSnapshot(
  before: string, after: string, writeSnapshot: (text: string) => Promise<unknown>,
  assertCompatible: (problems: string[]) => void | Promise<void>,
): Promise<void> {
  await assertCompatible(sdkBreakingChanges(before, after));
  await writeSnapshot(after);
}
