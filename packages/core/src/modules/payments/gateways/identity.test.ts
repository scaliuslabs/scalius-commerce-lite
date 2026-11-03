// packages/core/src/modules/payments/gateways/identity.test.ts
// Tests for COD country policy (Finding E — Egypt COD report).
// COD_COUNTRIES = ["BD"] — Egypt ("EG") is NOT included. No code change.

import { describe, expect, it } from "vitest";
import { COD_COUNTRIES } from "./identity";

describe("COD_COUNTRIES — country policy (Finding E)", () => {
    it("COD_COUNTRIES equals [BD] — cash on delivery is Bangladesh-only", () => {
        expect(COD_COUNTRIES).toEqual(["BD"]);
    });

    it("Egypt (EG) is not in COD_COUNTRIES", () => {
        expect(COD_COUNTRIES).not.toContain("EG");
    });

    it("COD_COUNTRIES contains exactly one country", () => {
        expect(COD_COUNTRIES).toHaveLength(1);
    });
});
