// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { HELP_LINKS } from "~/lib/help-links";
import { EmptyState } from "./EmptyState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("empty state", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const Icon = () => <svg />;

  it("says what the screen is, offers its one action and a way to ask for help on a first-run page", () => {
    act(() => root.render(<EmptyState icon={Icon} title="No orders yet" description="Orders appear here." action={<button type="button">Create order</button>} help />));
    expect(container.querySelector("h2")?.textContent).toBe("No orders yet");
    expect(container.textContent).toContain("Orders appear here.");
    expect(container.querySelector("button")?.textContent).toBe("Create order");
    const help = container.querySelector("a");
    expect(help?.getAttribute("href")).toBe(HELP_LINKS.questions);
    expect(help?.getAttribute("rel")).toContain("noopener");
    expect(help?.textContent).toBe(translate(resourceMessages, "emptyHelp"));
  });

  it("leaves the help link out of a filtered or placeholder state", () => {
    act(() => root.render(<EmptyState icon={Icon} title="No results" />));
    expect(container.querySelector("a")).toBeNull();
  });
});
