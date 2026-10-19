// Searching and filtering by buyer contact data (COMMERCE-HOOKS H5): an app
// may not look a buyer up by what it may not read. A list's email filter
// needs `read_customer_emails`, a phone filter `read_customer_phones`, and a
// free-text search the scope of what it matches (a phone, an email, or the
// names, emails and phones the text index holds). Without it the request is
// refused with 403 `contact_scope_required`, never silently widened or
// ignored. Staff and the merchant's own agents read contact fields, so they
// may search by them.
import type { Context } from "hono";
import { AppError } from "@scalius/core/errors";
import { isEmailSearch, isLikelyPhoneSearch } from "@scalius/core/utils/phone-search";
import type { ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import type { PluginPrincipal } from "../../agent-access/types";

const SCOPE_OF: Record<ProtectedCustomerData, string> = {
  name: "read_customer_names",
  email: "read_customer_emails",
  phone: "read_customer_phones",
  address: "read_customer_addresses",
};

/** The categories the caller may not read: an app's ungranted ones; nothing for staff and agents. */
function hiddenCategories(c: Context): ReadonlySet<ProtectedCustomerData> {
  const plugin = c.get("pluginPrincipal") as PluginPrincipal | undefined;
  if (!plugin) return new Set();
  return new Set((Object.keys(SCOPE_OF) as ProtectedCustomerData[]).filter((category) => !plugin.protectedData.has(category)));
}

function refuse(parameter: string, categories: readonly ProtectedCustomerData[]): never {
  const scopes = categories.map((category) => SCOPE_OF[category]);
  throw new AppError(
    403,
    "contact_scope_required",
    `Searching or filtering by ${parameter} needs the ${scopes.join(" and ")} scope${scopes.length > 1 ? "s" : ""}.`,
    { parameter, scopes },
  );
}

/** Refuses a filter on a contact field the caller may not read. */
export function assertContactFilterAllowed(c: Context, parameter: string, category: ProtectedCustomerData): void {
  if (hiddenCategories(c).has(category)) refuse(parameter, [category]);
}

/**
 * The contact categories a free-text order or customer search reads: a phone
 * written any way, a whole email, or a word of the names, emails and phones
 * in the text index.
 */
export function contactSearchCategories(term: string): ProtectedCustomerData[] {
  const value = term.trim();
  if (!value) return [];
  if (isLikelyPhoneSearch(value)) return ["phone"];
  if (isEmailSearch(value)) return ["email"];
  return ["name", "email", "phone"];
}

/** Refuses a free-text search over contact data the caller may not read. */
export function assertContactSearchAllowed(c: Context, parameter: string, term: string | null | undefined): void {
  if (!term) return;
  const hidden = hiddenCategories(c);
  if (hidden.size === 0) return;
  const missing = contactSearchCategories(term).filter((category) => hidden.has(category));
  if (missing.length > 0) refuse(parameter, missing);
}
