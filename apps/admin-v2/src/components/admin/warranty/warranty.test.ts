import { describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { orderWarranties } from "../orderview/WarrantyLinesCard";
import { policyBody } from "../settings/warranty-policies/WarrantyPolicyDialog";
import { warrantySummary } from "./warranty-format";

const t = ((key: keyof typeof warrantyMessages.en, vars?: Record<string, string | number>) =>
  translate(warrantyMessages, key, vars)) as Parameters<typeof warrantySummary>[0];

describe("warranty dashboard helpers", () => {
  it("summarises a policy like the storefront trust row", () => {
    expect(warrantySummary(t, { durationValue: 1, durationUnit: "years", provider: "brand", replacementDays: 7 }))
      .toBe("1 year brand warranty · 7-day replacement");
    expect(warrantySummary(t, { durationValue: 6, durationUnit: "months", provider: "store", replacementDays: 0 }))
      .toBe("6 months store warranty");
  });

  it("validates a policy draft before sending it", () => {
    const draft = { name: "  ", provider: "brand" as const, durationValue: 0, durationUnit: "years" as const, replacementDays: 91, terms: "" };
    expect(policyBody(draft)).toEqual({ errors: { name: "nameRequired", durationValue: "durationInvalid", replacementDays: "replacementInvalid" } });
    expect(policyBody({ ...draft, name: " 1 year official ", durationValue: 1, replacementDays: null, terms: " Keep the box " })).toEqual({
      body: { name: "1 year official", provider: "brand", durationValue: 1, durationUnit: "years", replacementDays: null, terms: "Keep the box" },
    });
  });

  it("reads each line's warranty records and ignores malformed ones", () => {
    const rows = orderWarranties({
      items: [
        {
          productName: "Phone",
          variantLabel: "Black",
          extras: {
            warranty: [
              {
                warrantyId: "wty_12345678",
                policyName: "1 year official",
                provider: "brand",
                durationValue: 1,
                durationUnit: "years",
                replacementDays: 7,
                quantity: 1,
                expiresAt: "2027-09-26T00:00:00.000Z",
                replacementUntil: null,
                voided: false,
                openClaimId: null,
                claim: { id: "wcl_12345678", conversationId: "conv_1", status: "resolved", resolution: "repair" },
              },
              { warrantyId: 3 },
            ],
          },
        },
        { productName: "Case", variantLabel: null },
      ] as never,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productName: "Phone", policyName: "1 year official", claim: { status: "resolved" } });
  });
});
