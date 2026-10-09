import { describe, expect, it } from "vitest";
import { MARKETING_CHANNELS, normalizeCustomerTag } from "@scalius/shared/customer-marketing";
import {
  CUSTOMER_CHANNELS,
  CUSTOMER_FILTER_PARAMS,
  customerListFilters,
  isCustomerSegmentId,
  normalizeTagParam,
  validateCustomerSearch,
} from "./customer-list-search";
import type { SearchValidatorInput } from "~/lib/list-helpers";

const validate = (value: Record<string, unknown>) => validateCustomerSearch(value as unknown as SearchValidatorInput);

describe("customers list URL state", () => {
  it("keeps the shared tag rule and channel list without importing them (route code stays zod-free)", () => {
    expect(CUSTOMER_CHANNELS).toEqual(MARKETING_CHANNELS);
    for (const input of ["VIP", "  Big   Spender ", "eid,2026", "éid", "ঢাকা", "", "   ", "x".repeat(40), "x".repeat(41), "😀".repeat(40)]) {
      expect(normalizeTagParam(input), input).toBe(normalizeCustomerTag(input) ?? undefined);
    }
    expect(normalizeTagParam(42)).toBeUndefined();
  });

  it("reads the tab, channel, tag and segment and drops anything else", () => {
    const search = validate({ view: "subscribers", channel: "sms", tag: " VIP ", segmentId: "seg_abc123", page: "2" });
    expect(search).toMatchObject({ view: "subscribers", channel: "sms", tag: "vip", segmentId: "seg_abc123", page: 2, sort: "updatedAt", limit: 50 });

    expect(validate({ view: "everyone", channel: "fax", segmentId: "cus_1", tag: "x".repeat(41) })).toMatchObject({
      view: undefined,
      channel: undefined,
      tag: undefined,
      segmentId: undefined,
    });
    // A channel narrows only the Subscribers tab.
    expect(validate({ channel: "email" }).channel).toBeUndefined();
  });

  it("reads an app filter and treats it as a filter the list can clear", () => {
    expect(validate({ appFilter: "acme.crm/tier:gold" }).appFilter).toBe("acme.crm/tier:gold");
    expect(validate({ appFilter: "gold" }).appFilter).toBeUndefined();
    expect(CUSTOMER_FILTER_PARAMS).toContain("appFilter");
    // The CSV export has no app filter: the list's own request carries it.
    expect(customerListFilters(validate({ appFilter: "acme.crm/tier:gold" }))).toEqual({});
  });

  it("knows a segment id when it sees one", () => {
    expect(isCustomerSegmentId("seg_Ab-9_x")).toBe(true);
    expect(isCustomerSegmentId("seg_")).toBe(false);
    expect(isCustomerSegmentId("seg_a/b")).toBe(false);
    expect(isCustomerSegmentId(undefined)).toBe(false);
  });

  it("turns the URL state into the API's list filters", () => {
    expect(customerListFilters(validate({}))).toEqual({});
    expect(customerListFilters(validate({ view: "subscribers" }))).toEqual({ subscribed: "any" });
    expect(customerListFilters(validate({ view: "subscribers", channel: "whatsapp", tag: "vip" }))).toEqual({
      tag: "vip",
      subscribed: "whatsapp",
    });
    expect(customerListFilters(validate({ segmentId: "seg_1" }))).toEqual({ segmentId: "seg_1" });
    // Trash has no Subscribers tab.
    expect(customerListFilters({ ...validate({ view: "subscribers" }), trashed: true })).toEqual({});
  });
});
