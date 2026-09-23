import { describe, expect, it } from "vitest";

import { normalizeAccountSection } from "./account-sections";

describe("account section search state", () => {
  it("keeps supported deep links", () => {
    expect(normalizeAccountSection("profile")).toBe("profile");
    expect(normalizeAccountSection("sessions")).toBe("sessions");
  });

  it("falls back to the non-destructive personal profile", () => {
    expect(normalizeAccountSection("billing")).toBe("profile");
    // Staff and roles moved to Settings → Users and permissions.
    expect(normalizeAccountSection("team")).toBe("profile");
    expect(normalizeAccountSection("roles")).toBe("profile");
    expect(normalizeAccountSection(undefined)).toBe("profile");
  });
});
