import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manager = readFileSync(new URL("./MediaManager.tsx", import.meta.url), "utf8");
const lazyManager = readFileSync(new URL("./LazyMediaManager.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./MediaWorkspace.tsx", import.meta.url), "utf8");
const managerHook = readFileSync(new URL("./hooks/useMediaManager.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../../ui/dialog.tsx", import.meta.url), "utf8");

describe("MediaManager picker selection boundary", () => {
  it("does not turn a single picker into toggle mode when it has a current value", () => {
    expect(manager).toContain("manager.setSelectionMode(!!onSelectMultiple)");
    expect(manager).not.toContain("!!onSelectMultiple || selectedFiles.length > 0");
  });

  it("starts standalone selection empty and keeps select-all explicit", () => {
    expect(managerHook).toContain("const beginSelection = useCallback(() => {");
    expect(managerHook).toMatch(/const beginSelection = useCallback\(\(\) => \{[\s\S]*?setSelectedFileIds\(\[\]\);[\s\S]*?setSelectionMode\(true\);/);
    expect(managerHook).toContain("setSelectedFileIds(selectAllVisibleMedia(visibleIds))");
  });

  it("supports Escape cancellation only in the standalone library", () => {
    expect(workspace).toContain('event.key !== "Escape"');
    expect(workspace).toContain("cancelSelection()");
    expect(workspace).toContain("onCancelSelection={!picker ? mm.cancelSelection : undefined}");
  });

  it("uses the workspace Close action without rendering a second dialog X", () => {
    expect(manager).toContain("showCloseButton={false}");
    expect(manager).toContain("onClose={() => onOpenChange(false)}");
    expect(workspace).toContain(">Close</Button>");
    expect(dialog).toContain("showCloseButton = true");
    expect(dialog).toContain("{showCloseButton ? (");
  });

  it("keeps lazy loading and dialog visibility under one controlled owner", () => {
    expect(manager).toContain("open: boolean");
    expect(manager).toContain("onOpenChange: (open: boolean) => void");
    expect(lazyManager).toContain("<Dialog open={open} onOpenChange={handleOpenChange}>");
    expect(lazyManager).toContain("<DialogTrigger asChild>");
    expect(lazyManager).toContain("if (!nextOpen) setShouldLoad(false)");
    expect(manager).not.toContain("<DialogTrigger");
    expect(lazyManager).not.toContain("initialOpen");
  });
});
