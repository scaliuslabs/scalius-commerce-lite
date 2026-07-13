import { describe, expect, it } from "vitest";

import { normalizeAccountSection } from "./account-sections";

describe("account section search state", () => {
  it("keeps supported deep links", () => {
    expect(normalizeAccountSection("team")).toBe("team");
    expect(normalizeAccountSection("roles")).toBe("roles");
  });

  it("fails closed to personal security for unknown values", () => {
    expect(normalizeAccountSection("billing")).toBe("security");
    expect(normalizeAccountSection(undefined)).toBe("security");
  });
});
