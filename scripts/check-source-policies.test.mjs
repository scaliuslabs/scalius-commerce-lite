import { describe, expect, it } from "vitest";

import { collectSourcePolicyViolations, policies, policyViolations } from "./check-source-policies.mjs";

describe("source policies", () => {
  it("holds for the current tree", () => {
    expect(collectSourcePolicyViolations()).toEqual([]);
  });

  it.each(policies)("catches a sample violation: $rule", (policy) => {
    expect(policyViolations(policy, [{ name: "sample", text: policy.sample }])).not.toEqual([]);
  });
});
