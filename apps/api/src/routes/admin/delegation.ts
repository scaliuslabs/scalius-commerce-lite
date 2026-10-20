// Whose authority a staff, role or permission write delegates.
import type { Context } from "hono";

/**
 * The signed-in store owner may grant any permission. An agent or app acting
 * for the owner holds only its grant's permissions (`adminPermissions`), so it
 * can never mint a role, an assignment, an override or a staff account above
 * its own grant, nor hand out the Super Admin role.
 */
export function delegatingUser(c: Context): { isSuperAdmin: boolean } {
    const actingForOwner = Boolean(c.get("agentPrincipal") ?? c.get("pluginPrincipal"));
    return { isSuperAdmin: c.get("user")?.isSuperAdmin === true && !actingForOwner };
}
