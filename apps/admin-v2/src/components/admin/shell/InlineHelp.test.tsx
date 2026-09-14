// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InlineHelp } from "./InlineHelp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("InlineHelp", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  it("describes the field it is wired to", async () => {
    await render(
      <>
        <input id="storefront-url" aria-describedby="storefront-url-help" />
        <InlineHelp id="storefront-url-help">
          Links, discovery XML, and checkout returns use this origin.
        </InlineHelp>
      </>,
    );

    const help = host.querySelector<HTMLElement>('[data-testid="inline-help"]')!;
    expect(help.id).toBe("storefront-url-help");
    expect(help.textContent).toContain("discovery XML");
    expect(help.className).toContain("text-muted-foreground");
  });

  it("renders nothing when there is no help text", async () => {
    await render(<InlineHelp>{null}</InlineHelp>);
    expect(host.querySelector('[data-testid="inline-help"]')).toBeNull();
  });
});
