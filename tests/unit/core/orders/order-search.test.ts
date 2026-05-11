import { describe, expect, it } from "vitest";
import {
    buildPhoneSearchTerms,
    isLikelyPhoneSearch,
} from "../../../../packages/core/src/modules/orders/orders.search";

describe("order phone search", () => {
    it("matches Bangladeshi local mobile input against E.164 storage", () => {
        expect(buildPhoneSearchTerms("01774452222")).toEqual([
            "01774452222",
            "1774452222",
            "8801774452222",
        ]);
    });

    it("matches E.164 input against local-format storage", () => {
        expect(buildPhoneSearchTerms("+880 1774-452222")).toEqual([
            "8801774452222",
            "1774452222",
            "01774452222",
        ]);
    });

    it("matches international dial-prefix input", () => {
        expect(buildPhoneSearchTerms("008801774452222")).toContain("01774452222");
    });

    it("expands subscriber-only Bangladeshi mobile fragments", () => {
        expect(buildPhoneSearchTerms("177445")).toEqual([
            "177445",
            "0177445",
            "880177445",
        ]);
    });

    it("does not treat short numeric fragments as phone searches", () => {
        expect(buildPhoneSearchTerms("123")).toEqual([]);
        expect(isLikelyPhoneSearch("123")).toBe(false);
    });

    it("recognizes phone searches with punctuation", () => {
        expect(isLikelyPhoneSearch("+880 (1774) 452-222")).toBe(true);
    });

    it("does not classify normal text as phone search", () => {
        expect(isLikelyPhoneSearch("Ahmed Rifat")).toBe(false);
    });
});
