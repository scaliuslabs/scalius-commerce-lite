import { describe, expect, it } from "vitest";

import { normalizeAccountSection } from "./account-sections";

describe("account section search state", () => {
  it("keeps supported deep links", () => {
    expect(normalizeAccountSection("profile")).toBe("profile");
    expect(normalizeAccountSection("sessions")).toBe("sessions");
    expect(normalizeAccountSection("team")).toBe("team");
    expect(normalizeAccountSection("roles")).toBe("roles");
  });

  it("falls back to the non-destructive personal profile", () => {
    expect(normalizeAccountSection("billing")).toBe("profile");
    expect(normalizeAccountSection(undefined)).toBe("profile");
  });
});
