import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderContractModule, SDK_CONTRACT_GEN, STABLE_SNAPSHOT } from "./plugin-contract.mjs";

describe("the SDK's stable app API contract", () => {
  it("is the sealed stable-operations snapshot (refresh with node scripts/plugin-contract.mjs)", () => {
    expect(readFileSync(SDK_CONTRACT_GEN, "utf8")).toBe(renderContractModule(readFileSync(STABLE_SNAPSHOT, "utf8")));
  });
});
