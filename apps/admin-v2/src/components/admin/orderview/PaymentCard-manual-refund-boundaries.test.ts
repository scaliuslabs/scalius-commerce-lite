import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PAYMENT_CARD_SOURCE = fileURLToPath(new URL("./PaymentCard.tsx", import.meta.url));

describe("PaymentCard manual COD refund boundary", () => {
  it("requires an explicit already-repaid confirmation and uses truthful manual copy", () => {
    const source = readFileSync(PAYMENT_CARD_SOURCE, "utf8");

    expect(source).toContain('import { Checkbox } from "@/components/ui/checkbox"');
    expect(source).toContain("manualSettlementConfirmed");
    expect(source).toContain("Scalius will not transfer money for a cash-on-delivery refund.");
    expect(source).toContain("I confirm the customer has already received the COD refund outside Scalius.");
    expect(source).toContain('manualSettlementConfirmed: requiresManualSettlementConfirmation ? true : undefined');
    expect(source).toContain("requiresManualSettlementConfirmation && !manualSettlementConfirmed");
    expect(source).toContain('requiresManualSettlementConfirmation ? "Record manual cash refund" : "Submit Refund"');
  });
});
