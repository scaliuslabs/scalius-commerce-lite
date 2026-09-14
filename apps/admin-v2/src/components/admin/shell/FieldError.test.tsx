// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FieldError } from "./FieldError";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FieldError", () => {
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

  it("announces the message with an icon", async () => {
    await render(<FieldError id="api-url-error">Use an HTTPS origin.</FieldError>);

    const error = host.querySelector<HTMLElement>('[data-testid="field-error"]')!;
    expect(error.id).toBe("api-url-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Use an HTTPS origin.");
    expect(error.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(error.className).toContain("text-destructive");
  });

  it("renders nothing while the field is valid", async () => {
    for (const value of [undefined, null, "", false] as const) {
      await render(<FieldError>{value}</FieldError>);
      expect(host.querySelector('[data-testid="field-error"]')).toBeNull();
    }
  });
});
