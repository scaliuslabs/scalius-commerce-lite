// The SDK seal reads emitted declarations, not implementation text. Existing
// declarations are invariant: a type can be both an app input and a host output.
// New exports, overloads and optional object members (also in a function's
// result type) are additive, as is a constant's declared type gaining members
// or trailing readonly-tuple entries (apps read a constant, never make one).
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
 * How a type may grow. A type apps may construct (an interface, a type alias,
 * a function's result) gains optional members only. A constant's declared
 * type (`declare const X: { … }`) is a value the host makes and an app only
 * reads, so it may also gain required members and its readonly tuples may
 * gain trailing members (a new list entry, a new limit).
 */
interface Growth {
  required: boolean;
}
const OPTIONAL_ONLY: Growth = { required: false };
const CONSTANT: Growth = { required: true };

function compatibleMembers(
  before: readonly ts.TypeElement[], after: readonly ts.TypeElement[],
  oldSource: ts.SourceFile, newSource: ts.SourceFile, growth: Growth = OPTIONAL_ONLY,
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
        && compatibleType(member.type, next.type, oldSource, newSource, growth);
    })) return false;
  }
  // A new required member breaks apps that construct the public type (never a constant's).
  return after.every((member) => existing.has(memberKey(member, newSource)) || !!member.questionToken || growth.required);
}

/** A readonly tuple's elements (`readonly [a, b]`); null for any other type. */
function readonlyTuple(node: ts.TypeNode): readonly ts.TypeNode[] | null {
  return ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword && ts.isTupleTypeNode(node.type)
    ? node.type.elements
    : null;
}

function compatibleType(
  before: ts.TypeNode | undefined, after: ts.TypeNode | undefined,
  oldSource: ts.SourceFile, newSource: ts.SourceFile, growth: Growth = OPTIONAL_ONLY,
): boolean {
  if (!before || !after) return before === after;
  if (print(before, oldSource) === print(after, newSource)) return true;
  // A constant's list keeps every member in its place and only gains trailing ones.
  const oldTuple = growth.required ? readonlyTuple(before) : null;
  const newTuple = oldTuple ? readonlyTuple(after) : null;
  if (oldTuple && newTuple) {
    return newTuple.length >= oldTuple.length
      && oldTuple.every((element, index) => print(element, oldSource) === print(newTuple[index]!, newSource));
  }
  return ts.isTypeLiteralNode(before) && ts.isTypeLiteralNode(after)
    && compatibleMembers(before.members, after.members, oldSource, newSource, growth);
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
  // A constant keeps its modifiers and name; its declared type may grow as a constant's does.
  if (ts.isVariableDeclaration(oldNode) && ts.isVariableDeclaration(newNode) && oldNode.type && newNode.type && !oldNode.initializer && !newNode.initializer) {
    const prefix = (declaration: Declaration, node: ts.VariableDeclaration, source: ts.SourceFile) =>
      declaration.text.slice(0, declaration.text.length - print(node, source).length) + print(node.name, source);
    return prefix(before, oldNode, oldSource) === prefix(after, newNode, newSource)
      && compatibleType(oldNode.type, newNode.type, oldSource, newSource, CONSTANT);
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
