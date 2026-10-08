// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ltr, stripIsolates } from "./bidi";

describe("bidi isolation", () => {
  it("wraps a value in left-to-right isolates and removes them again", () => {
    expect(ltr("+8801711000000")).toBe("⁦+8801711000000⁩");
    expect(stripIsolates(ltr("-15%"))).toBe("-15%");
    expect(ltr(126)).toBe("⁦126⁩");
  });

  it("leaves nothing for an empty value", () => {
    expect(ltr("")).toBe("");
    expect(ltr(null)).toBe("");
    expect(ltr(undefined)).toBe("");
  });
});
