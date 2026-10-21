// App-defined customer roles (docs/platform/PLUGINS.md, "Customer roles"):
// an app grants a role it names (`seller`, `wholesale`) to a customer, with
// an optional reference to its own record (`ref`). Each app reads and writes
// only its own roles (`ctx.customers.roles`); proxied app pages see them as
// `request.customer.roles` and checkout functions as `cart.customer.roles`.
// The same rules as the `plugin_customer_roles` table checks. Pure: the
// sandbox wrapper bundles it. Part of the versioned plugin API.

/** A role name: a lower-case letter, then up to 31 letters, digits, `_` or `-`. */
export const PLUGIN_CUSTOMER_ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
/** A role's `ref` (the app's own record id): 1 to 128 printable characters. */
export const PLUGIN_CUSTOMER_ROLE_REF_PATTERN = /^[\x20-\x7E]{1,128}$/u;
/** Roles one app holds on one customer at most. */
export const PLUGIN_CUSTOMER_ROLES_MAX = 10;

/** One role as apps read it. */
export interface PluginCustomerRole {
  role: string;
  ref: string | null;
}

/** One role with when it was granted (`ctx.customers.roles.list`). */
export interface PluginCustomerRoleGrant extends PluginCustomerRole {
  /** ISO 8601. */
  grantedAt: string;
}
