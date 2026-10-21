// App operation names: what an app passes to `ctx.api.call`. An app names
// the resource and the verb (`orders.get`, `products.create`), never the
// dashboard's route tree, so each operation has exactly one app name:
//
//   dashboard.resources.<resource>.<verb>  ->  <resource>.<verb>
//   dashboard.<resource>.<verb>            ->  <resource>.<verb>, unless a
//                                              resources operation owns it
//   objects.<...>                          ->  objects.<...>
//
// Where both shapes exist (`dashboard.orders.get` beside
// `dashboard.resources.orders.get`), the resource representation owns the
// name and the dashboard screen's own operation has none: no app reaches it.
// Storefront and system operations have no app name either. The stable app
// API (`apps/api/src/openapi/stable-operations.snapshot.json`) is keyed by
// these names, so the table is sealed with the contract.

/** The shape of an app operation name: lower snake segments joined by dots. */
export const APP_OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

const RESOURCES = "dashboard.resources.";
const DASHBOARD = "dashboard.";

/**
 * Every operation's app name, from the operation ids the host knows:
 * `{ name -> operationId }`. Throws on two operations with one name.
 */
export function appOperationNames(operationIds: Iterable<string>): Map<string, string> {
  const ids = new Set(operationIds);
  const names = new Map<string, string>();
  for (const operationId of [...ids].sort()) {
    let name: string | null = null;
    if (operationId.startsWith(RESOURCES)) name = operationId.slice(RESOURCES.length);
    else if (operationId.startsWith("objects.")) name = operationId;
    else if (operationId.startsWith(DASHBOARD)) {
      const candidate = operationId.slice(DASHBOARD.length);
      if (!ids.has(RESOURCES + candidate)) name = candidate;
    }
    if (!name || !APP_OPERATION_NAME.test(name)) continue;
    const taken = names.get(name);
    if (taken) throw new Error(`App operation name ${name} would name both ${taken} and ${operationId}.`);
    names.set(name, operationId);
  }
  return names;
}
