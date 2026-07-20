import { describe, expect, it } from "vitest";

import { readQuotedHtmlAttribute } from "./html-attributes";

describe("readQuotedHtmlAttribute", () => {
  it("reads single- and double-quoted attributes case-insensitively", () => {
    expect(readQuotedHtmlAttribute("<script DATA-ID='one'>", "data-id")).toBe("one");
    expect(readQuotedHtmlAttribute('<script data-id = "two">', "data-id")).toBe("two");
  });

  it("rejects partial, unquoted, and unterminated attributes", () => {
    expect(readQuotedHtmlAttribute("<script not-data-id='one'>", "data-id")).toBeNull();
    expect(readQuotedHtmlAttribute("<script data-id=one>", "data-id")).toBeNull();
    expect(readQuotedHtmlAttribute("<script data-id='one>", "data-id")).toBeNull();
  });
});
