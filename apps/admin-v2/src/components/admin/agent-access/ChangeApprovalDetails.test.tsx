// @vitest-environment happy-dom

// Black-box M7: the approval page said "An AI assistant or access key" and
// "productIds=1 items". It now names the connection and the records.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

import { ChangeApprovalTargets, changeRequesterText } from "./ChangeApprovalDetails";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof aiAccessMessages.en, vars?: Record<string, string | number>) =>
  translate(aiAccessMessages, key, vars);

describe("the change approval details", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names the connection and the client it runs in", () => {
    expect(changeRequesterText(t, { name: "Claude Code", client: "Scalius CLI", kind: "cli" })).toBe("Claude Code via Scalius CLI");
    expect(changeRequesterText(t, { name: "CI", client: null, kind: "pat" })).toBe("CI (Access key)");
    expect(changeRequesterText(t, { name: "Codex", client: "Codex", kind: "oauth" })).toBe("Codex (AI assistant)");
    expect(changeRequesterText(t, null)).toBeNull();
  });

  it("lists the records by name, counts the rest, and says when a filter selects them", () => {
    act(() => root.render(
      <ChangeApprovalTargets
        targets={[
          { kind: "product", total: 3, names: ["Kurta", "Saree"], matching: false },
          { kind: "order", total: 1, names: ["#1001"], matching: false },
          { kind: "customer", total: 0, names: [], matching: true },
        ]}
      />,
    ));
    const text = container.textContent ?? "";
    expect(text).toContain("3 products");
    expect(text).toContain("Kurta");
    expect(text).toContain("Saree");
    expect(text).toContain("and 1 more");
    expect(text).toContain("1 order");
    expect(text).toContain("#1001");
    expect(text).toContain("All customers that match a filter");
    expect(text).not.toMatch(/productIds|items/);
  });

  it("shows nothing when the change names no store records", () => {
    act(() => root.render(<ChangeApprovalTargets targets={[]} />));
    expect(container.textContent).toBe("");
  });
});
