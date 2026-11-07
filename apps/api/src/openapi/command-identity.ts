// Which domain commands each route handler runs, read from the route modules'
// source with the TypeScript parser: the identity command-aliases.test.ts
// pairs operations by, so two operations that run one command (an app's
// `suppliers.create` and the dashboard's `inventory_suppliers.create` both
// call `createSupplier`) are found whatever they are named. Test-only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** A callee is a command when it changes state: these verbs, from a domain module or a route module. */
const COMMAND_NAME = /^(?:create|update|delete|archive|unarchive|restore|cancel|receive|ship|mark|set|adjust|issue|publish|rollback|run|execute|save|place|apply|approve|confirm|release|import|refund|trash|bulk|book|handOver|void|capture|charge|erase|merge|dismiss|show|send|reorder|move|duplicate|reject|reply|close|reopen|assign|grant|revoke|upsert|replace|attach|detach)[A-Z]\w*$/u;

/**
 * Callees that change nothing a gate guards, or that many unrelated
 * operations call beside their own command (a timeline line, a notification,
 * response headers, a factory of app functions): sharing one never makes two
 * operations aliases.
 */
const NOT_A_COMMAND = /Notification|(?:Headers|Functions)$|^(?:recordOrderEvent|recordAppCreatedResources|createAuth|setOrderFulfillmentLocation)$/u;

export interface HandlerCommands {
  operationId: string;
  file: string;
  commands: string[];
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.ts$/u.test(name) && !/\.(test|gen)\./u.test(name) ? [path] : [];
  });
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name && ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return null;
}

function createRouteOperationId(node: ts.Node | undefined): string | null {
  if (!node || !ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "createRoute") return null;
  const [argument] = node.arguments;
  return argument && ts.isObjectLiteralExpression(argument) ? stringProperty(argument, "operationId") : null;
}

const isCommand = (name: string) => COMMAND_NAME.test(name) && !NOT_A_COMMAND.test(name);

/**
 * A route made by a module's own factory, `mutationRoute("cancel", schema)`
 * whose `createRoute` names `dashboard.orders.return_${action}`: the
 * operation id with the factory's string arguments put in.
 */
function factoryOperationId(call: ts.CallExpression, factories: ReadonlyMap<string, ts.FunctionDeclaration>): string | null {
  if (!ts.isIdentifier(call.expression)) return null;
  const factory = factories.get(call.expression.text);
  if (!factory?.body) return null;
  const values = new Map<string, string>();
  factory.parameters.forEach((parameter, index) => {
    const argument = call.arguments[index];
    if (ts.isIdentifier(parameter.name) && argument && ts.isStringLiteralLike(argument)) values.set(parameter.name.text, argument.text);
  });
  let resolved: string | null = null;
  const visit = (node: ts.Node) => {
    if (resolved) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createRoute") {
      const [argument] = node.arguments;
      const property = argument && ts.isObjectLiteralExpression(argument)
        ? argument.properties.find((entry) => ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === "operationId")
        : undefined;
      const initializer = property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
      if (initializer && ts.isTemplateExpression(initializer)) {
        let text = initializer.head.text;
        for (const span of initializer.templateSpans) {
          const value = ts.isIdentifier(span.expression) ? values.get(span.expression.text) : undefined;
          if (value === undefined) return;
          text += value + span.literal.text;
        }
        resolved = text;
      } else if (initializer && ts.isStringLiteralLike(initializer)) {
        resolved = initializer.text;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return resolved;
}

/**
 * Every route handler of one module source with the commands it calls: a
 * command imported from a domain or route module, or one of the module's own
 * functions named as a command (an exported command another module imports
 * reads the same from both), followed through the module's own helpers.
 */
export function handlersInSource(file: string, text: string): HandlerCommands[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map<string, { name: string; from: string }>();
  const locals = new Map<string, ts.Node>();
  const routes = new Map<string, string>();
  const factories = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) factories.set(statement.name.text, statement);
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imported.set(element.name.text, { name: (element.propertyName ?? element.name).text, from });
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) locals.set(statement.name.text, statement.body);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const operationId = createRouteOperationId(declaration.initializer)
          ?? (ts.isCallExpression(declaration.initializer) ? factoryOperationId(declaration.initializer, factories) : null);
        if (operationId) routes.set(declaration.name.text, operationId);
        else if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) locals.set(declaration.name.text, declaration.initializer.body);
      }
    }
  }
  const commandsOf = (root: ts.Node): string[] => {
    const found = new Set<string>();
    const seen = new Set<ts.Node>();
    const walk = (node: ts.Node, depth: number) => {
      if (seen.has(node)) return;
      seen.add(node);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const from = imported.get(name);
        if (from) {
          const domain = from.from.startsWith("@scalius/core") || from.from.startsWith(".");
          if (domain && isCommand(from.name)) found.add(from.name);
        } else if (locals.has(name)) {
          if (isCommand(name)) found.add(name);
          if (depth < 3) walk(locals.get(name)!, depth + 1);
        }
      }
      ts.forEachChild(node, (child) => walk(child, depth));
    };
    walk(root, 0);
    return [...found].sort();
  };
  const handlers: HandlerCommands[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "openapi" && node.arguments.length >= 2) {
      const [route, handler] = node.arguments as unknown as [ts.Node, ts.Node];
      const operationId = createRouteOperationId(route) ?? (ts.isIdentifier(route) ? routes.get(route.text) ?? null : null);
      if (operationId) handlers.push({ operationId, file, commands: commandsOf(handler) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return handlers;
}

/** Every route handler under `routesDir` with the domain commands it runs. */
export function routeHandlerCommands(routesDir: string): HandlerCommands[] {
  return routeFiles(routesDir).flatMap((file) => handlersInSource(file, readFileSync(file, "utf8")));
}
