// Who a dashboard request acts as. An app's call runs with a `user` that is
// the Super Admin who approved the app (plugins/admin-request.ts), so route
// code never reads the request's `user` to record who acted: an app is
// recorded as itself, never as that admin (request-actor.test.ts holds every
// route module of an app-available write to these helpers).
import { ForbiddenError, UnauthorizedError } from "../../utils/api-error";

/** Any request context: these helpers read only its caller variables. */
type RequestContext = { get(key: "user" | "pluginPrincipal"): unknown };

/** The calling app's id, or null for staff and agents. */
export function requestAppId(c: RequestContext): string | null {
  return (c.get("pluginPrincipal") as { pluginId?: string } | undefined)?.pluginId ?? null;
}

/** The signed-in staff member (an agent's owner), or null for an app or no session. */
export function requestStaffUser(c: RequestContext): { id: string; email?: string; isSuperAdmin?: boolean } | null {
  if (requestAppId(c)) return null;
  const user = c.get("user") as { id?: string; email?: string; isSuperAdmin?: boolean } | undefined;
  return user?.id ? { id: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin } : null;
}

/**
 * Who acted, for a column that names any actor (stock movements, documents,
 * bulk runs, theme and menu publishes, customer history): `app:<id>` for an
 * app, the staff member's id otherwise.
 */
export function requestActorId(c: RequestContext): string | null {
  const app = requestAppId(c);
  return app ? `app:${app}` : requestStaffUser(c)?.id ?? null;
}

/**
 * The staff member who acted, for a column that references a staff account
 * (an order's timeline, a released hold, an issued gift card, a webhook's
 * creator): null for an app, which the audit log and the record's own app
 * attribution name instead.
 */
export function requestStaffId(c: RequestContext): string | null {
  return requestStaffUser(c)?.id ?? null;
}

/** A staff member's own action (their inbox, saved replies, review moderation, device tokens): an app is refused. */
export function requireStaffId(c: RequestContext, signInMessage: string): string {
  if (requestAppId(c)) throw new ForbiddenError("This is a staff member's own action; an app cannot take it.");
  const id = requestStaffId(c);
  if (!id) throw new UnauthorizedError(signInMessage);
  return id;
}
