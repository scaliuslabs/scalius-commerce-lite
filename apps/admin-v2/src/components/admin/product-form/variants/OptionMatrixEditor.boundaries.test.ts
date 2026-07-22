import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./OptionMatrixEditor.tsx", import.meta.url),
  "utf8",
);

describe("option matrix editor responsive boundaries", () => {
  it("keeps phone controls operable while preserving the desktop matrix density", () => {
    expect(source).toContain('className="h-11 text-sm md:h-8"');
    expect(source).toContain('className="h-11 w-11 text-muted-foreground hover:text-destructive md:h-8 md:w-8"');
    expect(source).toContain("h-11 px-2 text-xs md:h-7");
    expect(source).toContain("md:h-8");
  });

  it("gives mobile SKU selection and image actions full touch targets", () => {
    expect(source).toContain('className="flex h-11 w-11 shrink-0 items-center justify-center"');
    expect(source).toContain("relative flex h-11 w-11 items-center justify-center");
    expect(source).toContain("min-[360px]:grid-cols-[44px_44px_minmax(0,1fr)_44px_96px]");
    expect(source).toContain("min-[360px]:col-span-1");
  });

  it("keeps the dense matrix copy factual and concise", () => {
    expect(source).not.toContain("changes save together");
    expect(source).not.toContain("Options are customer choices");
    expect(source).not.toContain("Try Size, Color, Format, Shape, or Pack.");
    expect(source).toContain("options.length > 0 && !combinationsPending");
  });
});
