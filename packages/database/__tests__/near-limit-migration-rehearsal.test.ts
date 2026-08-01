import { describe, expect, it } from "vitest";

import { parseByteSize } from "../scripts/near-limit-migration-rehearsal";

describe("near-limit migration rehearsal sizing", () => {
  it("parses explicit binary byte units", () => {
    expect(parseByteSize("1MiB")).toBe(1024 ** 2);
    expect(parseByteSize("0.5GiB")).toBe(512 * 1024 ** 2);
    expect(parseByteSize("8388608B")).toBe(8_388_608);
  });

  it("rejects ambiguous or tiny targets", () => {
    expect(() => parseByteSize("8GB")).toThrow(/MiB, or GiB/);
    expect(() => parseByteSize("512B")).toThrow(/at least 1MiB/);
  });
});
