import { describe, expect, it, vi } from "vitest";
import {
  chooseInitialTwoFactorMethod,
  clearPendingTwoFactorMethods,
  normalizePendingTwoFactorMethods,
  readPendingTwoFactorMethods,
  storePendingTwoFactorMethods,
} from "./two-factor-pending";

describe("pending two-factor method policy", () => {
  it("normalizes Better Auth pending methods into local verification methods", () => {
    expect(normalizePendingTwoFactorMethods(["totp", "otp", "email", "totp", "unknown"])).toEqual([
      "totp",
      "email",
    ]);
  });

  it("prefers explicit defaults, then pending sign-in methods, then API preference", () => {
    expect(chooseInitialTwoFactorMethod({ defaultMethod: "email", pendingMethods: ["totp"] })).toBe("email");
    expect(chooseInitialTwoFactorMethod({ pendingMethods: ["totp"], apiMethod: "email" })).toBe("totp");
    expect(chooseInitialTwoFactorMethod({ pendingMethods: ["email"], apiMethod: "totp" })).toBe("email");
    expect(chooseInitialTwoFactorMethod({ apiMethod: "totp" })).toBe("totp");
    expect(chooseInitialTwoFactorMethod({})).toBe("email");
  });

  it("stores, reads, and clears pending methods from session storage", () => {
    const storage = new Map<string, string>();
    const sessionStorageMock = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    };
    vi.stubGlobal("window", { sessionStorage: sessionStorageMock });

    storePendingTwoFactorMethods(["otp"]);
    expect(readPendingTwoFactorMethods()).toEqual(["email"]);

    clearPendingTwoFactorMethods();
    expect(readPendingTwoFactorMethods()).toEqual([]);

    vi.unstubAllGlobals();
  });
});
