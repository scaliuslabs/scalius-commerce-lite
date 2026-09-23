import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps a text colour next to a dashboard type-scale size", () => {
    expect(cn("text-primary-foreground", "text-body")).toBe("text-primary-foreground text-body");
    expect(cn("text-caption text-muted-foreground", "text-heading-md")).toBe("text-muted-foreground text-heading-md");
  });

  it("lets a later elevation token replace an earlier shadow", () => {
    expect(cn("shadow-card", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-sm", "shadow-popover")).toBe("shadow-popover");
  });
});
