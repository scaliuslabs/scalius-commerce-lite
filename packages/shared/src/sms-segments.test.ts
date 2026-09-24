import { describe, expect, it } from "vitest";
import { countSmsSegments } from "./sms-segments";

describe("countSmsSegments", () => {
  it("counts an empty message as nothing to send", () => {
    expect(countSmsSegments("")).toEqual({ characters: 0, segments: 0, encoding: "gsm7" });
  });

  it("fits 160 GSM characters in one SMS and splits at 153 after that", () => {
    expect(countSmsSegments("a".repeat(160))).toEqual({ characters: 160, segments: 1, encoding: "gsm7" });
    expect(countSmsSegments("a".repeat(161))).toEqual({ characters: 161, segments: 2, encoding: "gsm7" });
    expect(countSmsSegments("a".repeat(306)).segments).toBe(2);
    expect(countSmsSegments("a".repeat(307)).segments).toBe(3);
  });

  it("counts GSM extension characters twice", () => {
    // 159 + one € (2 units) = 161 units → two parts, but 160 characters.
    const result = countSmsSegments(`${"a".repeat(159)}€`);
    expect(result).toEqual({ characters: 160, segments: 2, encoding: "gsm7" });
    expect(countSmsSegments("{}").segments).toBe(1);
  });

  it("switches Bangla to Unicode: 70 in one SMS, 67 per part after that", () => {
    const bangla = "অর্ডার";
    expect(countSmsSegments(bangla).encoding).toBe("unicode");
    expect(countSmsSegments("ক".repeat(70)).segments).toBe(1);
    expect(countSmsSegments("ক".repeat(71)).segments).toBe(2);
    expect(countSmsSegments("ক".repeat(134)).segments).toBe(2);
    expect(countSmsSegments("ক".repeat(135)).segments).toBe(3);
  });

  it("makes the whole message Unicode when one character is outside GSM-7", () => {
    const result = countSmsSegments(`${"a".repeat(100)}’`);
    expect(result).toEqual({ characters: 101, segments: 2, encoding: "unicode" });
  });

  it("counts an emoji as two UCS-2 units but one character", () => {
    const result = countSmsSegments(`${"a".repeat(69)}🙂`);
    expect(result.characters).toBe(70);
    expect(result.segments).toBe(2);
  });
});
