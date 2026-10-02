// An app's checkout functions as the Apps list and the app page show them:
// in the order checkout reaches each point, then by priority.
import { APP_FUNCTION_POINTS, type AppFunction, type AppFunctionPoint } from "~/lib/api-query-options/apps";

/** A point the dashboard has words for; a newer API may send one it doesn't yet. */
export function isKnownFunctionPoint(point: string): point is AppFunctionPoint {
  return (APP_FUNCTION_POINTS as readonly string[]).includes(point);
}

function rank(point: string): number {
  return isKnownFunctionPoint(point) ? APP_FUNCTION_POINTS.indexOf(point) : APP_FUNCTION_POINTS.length;
}

export function checkoutFunctions(functions: readonly AppFunction[] | undefined): AppFunction[] {
  return [...(functions ?? [])].sort((a, b) => rank(a.point) - rank(b.point) || a.priority - b.priority);
}
