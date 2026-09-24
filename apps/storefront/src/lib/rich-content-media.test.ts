import { describe, expect, it } from "vitest";
import { demoteRichContentH1 } from "./rich-content-media";

describe("demoteRichContentH1", () => {
  it("turns merchant H1s into H2s and leaves other headings alone", () => {
    expect(demoteRichContentH1('<h1 class="x">VAPORESSO XROS 6 Mini</h1><h2>Specs</h2><H1>Box</H1>'))
      .toBe('<h2 class="x">VAPORESSO XROS 6 Mini</h2><h2>Specs</h2><h2>Box</h2>');
  });

  it("does not touch lookalike tags or text", () => {
    expect(demoteRichContentH1("<h10>x</h10><p>&lt;h1&gt;</p>")).toBe("<h10>x</h10><p>&lt;h1&gt;</p>");
  });
});
