// The segment builder's draft: what the merchant is editing (numbers may be
// empty or half typed, lists may be empty) and its conversion to and from the
// saved definition. Money is in decimal major units (taka), as the API takes it.
import {
  CUSTOMER_SEGMENT_CONDITIONS_MAX,
  CUSTOMER_SEGMENT_DAYS_MAX,
  CUSTOMER_SEGMENT_DEFINITION_VERSION,
  CUSTOMER_SEGMENT_VALUES_MAX,
  type CustomerSegmentDefinitionInput,
  type CustomerSegmentField,
  type MarketingChannel,
  type MarketingConsentStatus,
} from "@scalius/shared/customer-marketing";

export const SEGMENT_NAME_MAX = 80;
export const SEGMENT_DESCRIPTION_MAX = 300;
export const SEGMENT_CONDITIONS_MAX = CUSTOMER_SEGMENT_CONDITIONS_MAX;
export const SEGMENT_VALUES_MAX = CUSTOMER_SEGMENT_VALUES_MAX;

export type SegmentDateField = "last_order_date" | "first_order_date" | "customer_since";
export type SegmentDateOp = "within_last" | "not_within_last" | "on_or_after" | "before";
export type SegmentCustomerType = "account" | "guest" | "merchant";
export const SEGMENT_DATE_OPS = ["within_last", "not_within_last", "on_or_after", "before"] as const satisfies readonly SegmentDateOp[];
export const SEGMENT_CUSTOMER_TYPES = ["account", "guest", "merchant"] as const satisfies readonly SegmentCustomerType[];

type Keyed<T> = T & { key: string };

/** One filter as edited. Numbers are null while empty and NaN while not a number. */
export type ConditionDraft =
  | Keyed<{ field: "amount_spent" | "orders_count"; min: number | null; max: number | null }>
  | Keyed<{ field: SegmentDateField; op: SegmentDateOp; days: number | null; date: string }>
  | Keyed<{ field: "city" | "zone"; op: "in" | "not_in"; ids: string[] }>
  | Keyed<{ field: "tags"; op: "has_any" | "has_all" | "has_none"; tags: string[] }>
  | Keyed<{ field: "marketing_consent"; channel: MarketingChannel; status: MarketingConsentStatus }>
  | Keyed<{ field: "customer_type"; types: SegmentCustomerType[] }>
  | Keyed<{ field: "custom_field"; definitionId: string; op: "equals" | "is_set" | "is_not_set"; value: string }>;

export interface SegmentDraft {
  name: string;
  description: string;
  match: "all" | "any";
  conditions: ConditionDraft[];
}

/** Why a filter cannot be saved yet. */
export type ConditionProblem =
  | "range_empty"
  | "range_invalid"
  | "range_order"
  | "days_invalid"
  | "date_invalid"
  | "locations_empty"
  | "tags_empty"
  | "types_empty"
  | "field_empty"
  | "value_empty";

export type SegmentInputCondition = CustomerSegmentDefinitionInput["conditions"][number];

let lastKey = 0;
/** A React key for a new filter row (stable for the row's life). */
export const nextConditionKey = () => `condition-${++lastKey}`;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A new filter with sensible defaults (orders: at least 1; dates: last 30 days). */
export function newCondition(field: CustomerSegmentField, key = nextConditionKey()): ConditionDraft {
  switch (field) {
    case "amount_spent":
      return { key, field, min: null, max: null };
    case "orders_count":
      return { key, field, min: 1, max: null };
    case "last_order_date":
    case "first_order_date":
    case "customer_since":
      return { key, field, op: "within_last", days: 30, date: "" };
    case "city":
    case "zone":
      return { key, field, op: "in", ids: [] };
    case "tags":
      return { key, field, op: "has_any", tags: [] };
    case "marketing_consent":
      return { key, field, channel: "email", status: "subscribed" };
    case "customer_type":
      return { key, field, types: ["account"] };
    case "custom_field":
      return { key, field, definitionId: "", op: "is_set", value: "" };
  }
}

/** A saved condition as a draft row. */
export function conditionDraft(condition: SegmentInputCondition, key = nextConditionKey()): ConditionDraft {
  switch (condition.field) {
    case "amount_spent":
    case "orders_count":
      return { key, field: condition.field, min: condition.min ?? null, max: condition.max ?? null };
    case "last_order_date":
    case "first_order_date":
    case "customer_since": {
      const { filter } = condition;
      return filter.op === "within_last" || filter.op === "not_within_last"
        ? { key, field: condition.field, op: filter.op, days: filter.days, date: "" }
        : { key, field: condition.field, op: filter.op, days: null, date: filter.date };
    }
    case "city":
    case "zone":
      return { key, field: condition.field, op: condition.op, ids: [...condition.ids] };
    case "tags":
      return { key, field: "tags", op: condition.op, tags: [...condition.tags] };
    case "marketing_consent":
      return { key, field: "marketing_consent", channel: condition.channel, status: condition.status };
    case "customer_type":
      return { key, field: "customer_type", types: [...condition.types] };
    case "custom_field":
      return { key, field: "custom_field", definitionId: condition.definitionId, op: condition.op, value: condition.value ?? "" };
  }
}

/** The draft of a saved segment, or an empty one for a new segment. */
export function draftFromSegment(segment?: {
  name: string;
  description: string | null;
  /** As the API returns it (`match` may be left out: "all"). */
  definition: { match?: "all" | "any"; conditions: readonly SegmentInputCondition[] };
} | null): SegmentDraft {
  if (!segment) return { name: "", description: "", match: "all", conditions: [] };
  return {
    name: segment.name,
    description: segment.description ?? "",
    match: segment.definition.match ?? "all",
    conditions: segment.definition.conditions.map((condition) => conditionDraft(condition)),
  };
}

const isNumber = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** The filter as saved, or why it can't be yet. */
export function conditionFromDraft(draft: ConditionDraft): { condition: SegmentInputCondition } | { problem: ConditionProblem } {
  switch (draft.field) {
    case "amount_spent":
    case "orders_count": {
      if (draft.min === null && draft.max === null) return { problem: "range_empty" };
      const whole = draft.field === "orders_count";
      for (const value of [draft.min, draft.max]) {
        if (value === null) continue;
        if (!isNumber(value) || value < 0 || (whole && !Number.isInteger(value))) return { problem: "range_invalid" };
      }
      if (isNumber(draft.min) && isNumber(draft.max) && draft.min > draft.max) return { problem: "range_order" };
      return {
        condition: {
          field: draft.field,
          ...(draft.min !== null ? { min: draft.min } : {}),
          ...(draft.max !== null ? { max: draft.max } : {}),
        },
      };
    }
    case "last_order_date":
    case "first_order_date":
    case "customer_since": {
      if (draft.op === "within_last" || draft.op === "not_within_last") {
        const days = draft.days;
        if (!isNumber(days) || !Number.isInteger(days) || days < 1 || days > CUSTOMER_SEGMENT_DAYS_MAX) return { problem: "days_invalid" };
        return { condition: { field: draft.field, filter: { op: draft.op, days } } };
      }
      if (!isRealDate(draft.date)) return { problem: "date_invalid" };
      return { condition: { field: draft.field, filter: { op: draft.op, date: draft.date } } };
    }
    case "city":
    case "zone":
      if (draft.ids.length === 0) return { problem: "locations_empty" };
      return { condition: { field: draft.field, op: draft.op, ids: draft.ids.slice(0, CUSTOMER_SEGMENT_VALUES_MAX) } };
    case "tags":
      if (draft.tags.length === 0) return { problem: "tags_empty" };
      return { condition: { field: "tags", op: draft.op, tags: draft.tags.slice(0, CUSTOMER_SEGMENT_VALUES_MAX) } };
    case "marketing_consent":
      return { condition: { field: "marketing_consent", channel: draft.channel, status: draft.status } };
    case "customer_type":
      if (draft.types.length === 0) return { problem: "types_empty" };
      return { condition: { field: "customer_type", types: SEGMENT_CUSTOMER_TYPES.filter((type) => draft.types.includes(type)) } };
    case "custom_field":
      if (!draft.definitionId) return { problem: "field_empty" };
      if (draft.op === "equals") {
        if (!draft.value.trim()) return { problem: "value_empty" };
        return { condition: { field: "custom_field", definitionId: draft.definitionId, op: "equals", value: draft.value.trim() } };
      }
      return { condition: { field: "custom_field", definitionId: draft.definitionId, op: draft.op } };
  }
}

/**
 * The definition the draft describes, or null while any filter is unfinished
 * (or there is none); `problems` names each unfinished filter by its key.
 */
export function definitionFromDraft(draft: Pick<SegmentDraft, "match" | "conditions">): {
  definition: CustomerSegmentDefinitionInput | null;
  problems: Record<string, ConditionProblem>;
} {
  const problems: Record<string, ConditionProblem> = {};
  const conditions: SegmentInputCondition[] = [];
  for (const row of draft.conditions.slice(0, CUSTOMER_SEGMENT_CONDITIONS_MAX)) {
    const result = conditionFromDraft(row);
    if ("problem" in result) problems[row.key] = result.problem;
    else conditions.push(result.condition);
  }
  const complete = conditions.length > 0 && Object.keys(problems).length === 0;
  return {
    definition: complete ? { version: CUSTOMER_SEGMENT_DEFINITION_VERSION, match: draft.match, conditions } : null,
    problems,
  };
}

/** Same content, ignoring row keys. */
export function sameSegmentDraft(a: SegmentDraft, b: SegmentDraft): boolean {
  const plain = (draft: SegmentDraft) =>
    JSON.stringify({ ...draft, conditions: draft.conditions.map(({ key: _key, ...rest }) => rest) });
  return plain(a) === plain(b);
}

/** Whether the name can be saved (1 to 80 characters after trimming). */
export function segmentNameProblem(name: string): "required" | "too_long" | null {
  const value = name.replace(/\s+/g, " ").trim();
  if (!value) return "required";
  return value.length > SEGMENT_NAME_MAX ? "too_long" : null;
}
