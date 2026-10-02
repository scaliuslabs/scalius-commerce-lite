import { describe, expect, it } from "vitest";
import {
  SCANNER_LOCATION_STORAGE_KEY,
  pickScannerLocation,
  readRememberedScannerLocation,
  rememberScannerLocation,
} from "./scanner-location";

const main = { id: "loc_default", name: "Main location", isDefault: true };
const branch = { id: "loc_branch", name: "Banani store", isDefault: false };

describe("scanner location", () => {
  it("starts where this device last counted while that location is still active", () => {
    expect(pickScannerLocation([main, branch], "loc_branch")).toBe(branch);
    // Archived or unknown since: back to the default.
    expect(pickScannerLocation([main, branch], "loc_gone")).toBe(main);
    expect(pickScannerLocation([branch], null)).toBe(branch);
    expect(pickScannerLocation([], "loc_branch")).toBeNull();
  });

  it("remembers the choice per device and survives storage that throws", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    rememberScannerLocation("loc_branch", storage);
    expect(saved.get(SCANNER_LOCATION_STORAGE_KEY)).toBe("loc_branch");
    expect(readRememberedScannerLocation(storage)).toBe("loc_branch");

    const blocked = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    expect(readRememberedScannerLocation(blocked)).toBeNull();
    expect(() => rememberScannerLocation("loc_branch", blocked)).not.toThrow();
    expect(readRememberedScannerLocation(null)).toBeNull();
  });
});
