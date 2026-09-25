// Staff-typed recipients are validated, never silently dropped.
import { describe, expect, it } from "vitest";
import { normalizeGiftCardRecipient, parseGiftCardRecipientStrict } from "./issue";

describe("gift-card recipients", () => {
    it("rejects a bad staff-typed contact with a field error", () => {
        expect(() => parseGiftCardRecipientStrict({ phone: "12345" })).toThrow(expect.objectContaining({ details: { field: "recipient.phone" } }));
        expect(() => parseGiftCardRecipientStrict({ email: "not-an-email" })).toThrow(expect.objectContaining({ details: { field: "recipient.email" } }));
        expect(() => parseGiftCardRecipientStrict({ email: "a@b.co", phone: "01712345678" })).toThrow(/not both/);
    });

    it("keeps valid contacts, normalized", () => {
        expect(parseGiftCardRecipientStrict({ name: " Sadia ", phone: "01712345678" }))
            .toEqual({ name: "Sadia", email: null, phone: "+8801712345678" });
        expect(parseGiftCardRecipientStrict({ email: "Sadia@Example.test" }))
            .toEqual({ name: null, email: "sadia@example.test", phone: null });
        expect(parseGiftCardRecipientStrict({ name: "  " })).toBeNull();
    });

    it("reads frozen line properties leniently (already validated at checkout)", () => {
        expect(normalizeGiftCardRecipient({ name: "Sadia", phone: "12345" })).toEqual({ name: "Sadia", email: null, phone: null });
    });
});
