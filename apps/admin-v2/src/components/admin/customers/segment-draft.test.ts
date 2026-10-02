import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SEGMENT_FIELDS,
  customerSegmentDefinitionInputSchema,
  type CustomerSegmentDefinitionInput,
} from "@scalius/shared/customer-marketing";
import {
  conditionFromDraft,
  definitionFromDraft,
  draftFromSegment,
  newCondition,
  sameSegmentDraft,
  segmentNameProblem,
  type ConditionDraft,
} from "./segment-draft";

const SAVED: CustomerSegmentDefinitionInput = {
  version: 1,
  match: "any",
  conditions: [
    { field: "amount_spent", min: 5000.5 },
    { field: "orders_count", min: 2, max: 10 },
    { field: "last_order_date", filter: { op: "within_last", days: 90 } },
    { field: "first_order_date", filter: { op: "before", date: "2026-01-01" } },
    { field: "customer_since", filter: { op: "on_or_after", date: "2025-06-15" } },
    { field: "city", op: "in", ids: ["loc_dhaka"] },
    { field: "zone", op: "not_in", ids: ["loc_mirpur", "loc_uttara"] },
    { field: "tags", op: "has_all", tags: ["vip", "wholesale"] },
    { field: "marketing_consent", channel: "sms", status: "subscribed" },
    { field: "customer_type", types: ["account", "guest"] },
    { field: "custom_field", definitionId: "cfd_tier0001", op: "equals", value: "gold" },
    { field: "custom_field", definitionId: "cfd_tier0001", op: "is_not_set" },
  ],
};

const segment = { name: "Big spenders", description: null, definition: SAVED };

describe("segment builder draft", () => {
  it("round-trips a saved definition of every filter kind", () => {
    const draft = draftFromSegment(segment);
    expect(draft).toMatchObject({ name: "Big spenders", description: "", match: "any" });
    const { definition, problems } = definitionFromDraft(draft);
    expect(problems).toEqual({});
    expect(definition).toEqual(SAVED);
    expect(customerSegmentDefinitionInputSchema.safeParse(definition).success).toBe(true);
  });

  it("starts every field with a draft the merchant can finish, and a valid one where defaults suffice", () => {
    const ready = ["orders_count", "last_order_date", "first_order_date", "customer_since", "marketing_consent", "customer_type"];
    for (const field of CUSTOMER_SEGMENT_FIELDS) {
      const result = conditionFromDraft(newCondition(field));
      expect("condition" in result, field).toBe(ready.includes(field));
      if ("condition" in result) {
        expect(customerSegmentDefinitionInputSchema.safeParse({ conditions: [result.condition] }).success, field).toBe(true);
      }
    }
  });

  it("names what is unfinished in each filter", () => {
    const problem = (draft: ConditionDraft) => {
      const result = conditionFromDraft(draft);
      return "problem" in result ? result.problem : null;
    };
    expect(problem({ key: "a", field: "amount_spent", min: null, max: null })).toBe("range_empty");
    expect(problem({ key: "a", field: "amount_spent", min: Number.NaN, max: null })).toBe("range_invalid");
    expect(problem({ key: "a", field: "orders_count", min: 1.5, max: null })).toBe("range_invalid");
    expect(problem({ key: "a", field: "orders_count", min: 5, max: 2 })).toBe("range_order");
    expect(problem({ key: "a", field: "orders_count", min: null, max: 0 })).toBeNull();
    expect(problem({ key: "a", field: "last_order_date", op: "within_last", days: 0, date: "" })).toBe("days_invalid");
    expect(problem({ key: "a", field: "last_order_date", op: "within_last", days: 3651, date: "" })).toBe("days_invalid");
    expect(problem({ key: "a", field: "customer_since", op: "before", days: 30, date: "" })).toBe("date_invalid");
    expect(problem({ key: "a", field: "customer_since", op: "before", days: null, date: "2026-02-30" })).toBe("date_invalid");
    expect(problem({ key: "a", field: "city", op: "in", ids: [] })).toBe("locations_empty");
    expect(problem({ key: "a", field: "tags", op: "has_any", tags: [] })).toBe("tags_empty");
    expect(problem({ key: "a", field: "customer_type", types: [] })).toBe("types_empty");
    expect(problem({ key: "a", field: "custom_field", definitionId: "", op: "is_set", value: "" })).toBe("field_empty");
    expect(problem({ key: "a", field: "custom_field", definitionId: "cfd_x0001", op: "equals", value: "  " })).toBe("value_empty");
  });

  it("has no definition while a filter is unfinished or there is none", () => {
    expect(definitionFromDraft({ match: "all", conditions: [] })).toEqual({ definition: null, problems: {} });
    const unfinished = newCondition("tags", "row-1");
    const result = definitionFromDraft({ match: "all", conditions: [newCondition("orders_count", "row-0"), unfinished] });
    expect(result.definition).toBeNull();
    expect(result.problems).toEqual({ "row-1": "tags_empty" });
  });

  it("drops the value of a custom field filter that doesn't compare, and keeps customer types in order", () => {
    const { definition } = definitionFromDraft({
      match: "all",
      conditions: [
        { key: "a", field: "custom_field", definitionId: "cfd_x0001", op: "is_set", value: "left over" },
        { key: "b", field: "customer_type", types: ["merchant", "account"] },
      ],
    });
    expect(definition?.conditions).toEqual([
      { field: "custom_field", definitionId: "cfd_x0001", op: "is_set" },
      { field: "customer_type", types: ["account", "merchant"] },
    ]);
  });

  it("compares drafts by content, not row keys", () => {
    expect(sameSegmentDraft(draftFromSegment(segment), draftFromSegment(segment))).toBe(true);
    const edited = draftFromSegment(segment);
    edited.match = "all";
    expect(sameSegmentDraft(edited, draftFromSegment(segment))).toBe(false);
  });

  it("checks the name like the server (1 to 80 characters after trimming)", () => {
    expect(segmentNameProblem("  ")).toBe("required");
    expect(segmentNameProblem(" VIP ")).toBeNull();
    expect(segmentNameProblem("x".repeat(81))).toBe("too_long");
  });
});
