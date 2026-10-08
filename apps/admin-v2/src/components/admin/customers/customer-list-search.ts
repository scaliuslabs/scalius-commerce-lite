// The customers list's URL state. Route `validateSearch` code loads with the
// always-loaded route tree, so this module stays dependency-free (no zod, no
// `@scalius/shared/customer-marketing`): the tag rule and channel list are
// spelled out here and a test keeps them equal to the shared ones. Search
// terms never go in the URL (list-search.ts); a tag or segment id may.
import {
  createListSearchValidator,
  normalizeAppFilterSearchParam,
  normalizeOptionalEnumSearchParam,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";

export const CUSTOMER_SORTS = ["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"] as const;
export const CUSTOMER_VIEWS = ["subscribers"] as const;
export const CUSTOMER_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type CustomerChannel = (typeof CUSTOMER_CHANNELS)[number];
/** URL params set by the list's filters ("Clear filters" resets them). */
export const CUSTOMER_FILTER_PARAMS = ["tag", "segmentId", "channel", "appFilter"] as const;

const TAG_MAX_LENGTH = 40;
const SEGMENT_ID = /^seg_[A-Za-z0-9_-]{1,64}$/;

/** A saved segment's id (`seg_…`), as routes and filters accept it. */
export function isCustomerSegmentId(value: unknown): value is string {
  return typeof value === "string" && SEGMENT_ID.test(value);
}

/** Same rule as `normalizeCustomerTag` in `@scalius/shared/customer-marketing`. */
export function normalizeTagParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tag = value.normalize("NFC").replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return tag && [...tag].length <= TAG_MAX_LENGTH ? tag : undefined;
}

const validateBase = createListSearchValidator(CUSTOMER_SORTS, { sort: "updatedAt", limit: 20 });

export function validateCustomerSearch(search: SearchValidatorInput) {
  const view = normalizeOptionalEnumSearchParam(search.view, CUSTOMER_VIEWS);
  const base: ListSearchParams<(typeof CUSTOMER_SORTS)[number]> = validateBase(search);
  return {
    ...base,
    /** The Subscribers tab. */
    view,
    /** One channel, on the Subscribers tab only (any channel without it). */
    channel: view ? normalizeOptionalEnumSearchParam(search.channel, CUSTOMER_CHANNELS) : undefined,
    tag: normalizeTagParam(search.tag),
    segmentId: isCustomerSegmentId(search.segmentId) ? search.segmentId : undefined,
    /** An app column and its exact value: `<app id>/<column id>:<value>`. */
    appFilter: normalizeAppFilterSearchParam(search.appFilter),
  };
}

/** The validated search (an object type, so it also fits `Record<string, unknown>` search props). */
export type CustomerListSearch = ReturnType<typeof validateCustomerSearch>;

/** The list's filters as the API reads them (the list query and the CSV export). */
export function customerListFilters(search: CustomerListSearch): {
  tag?: string;
  segmentId?: string;
  subscribed?: CustomerChannel | "any";
} {
  const subscribed = search.view === "subscribers" && !search.trashed ? search.channel ?? "any" : undefined;
  return {
    ...(search.tag ? { tag: search.tag } : {}),
    ...(search.segmentId ? { segmentId: search.segmentId } : {}),
    ...(subscribed ? { subscribed } : {}),
  };
}
