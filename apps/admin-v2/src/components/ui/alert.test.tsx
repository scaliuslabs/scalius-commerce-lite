// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlertCircle } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Alert, AlertDescription, AlertTitle } from "./alert";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Alert", () => {
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

  const parts = () => {
    const alert = host.querySelector("[data-slot=alert]")!;
    return [...alert.children].map((child) => child.tagName.toLowerCase() === "svg" ? "icon" : child.getAttribute("data-slot"));
  };

  it("puts plain text and links in one full-width body (no zero-width icon column)", async () => {
    await act(async () => root.render(
      <Alert variant="warning">
        Add your business details. <a href="/admin/settings/store">Open settings</a>
      </Alert>,
    ));
    expect(parts()).toEqual(["alert-body"]);
    const body = host.querySelector("[data-slot=alert-body]")!;
    expect(body.className).toContain("flex-1");
    expect(body.textContent).toBe("Add your business details. Open settings");
  });

  it("keeps a leading icon in its own column beside the title and description", async () => {
    await act(async () => root.render(
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Couldn't save</AlertTitle>
        <AlertDescription>Try again.</AlertDescription>
      </Alert>,
    ));
    expect(parts()).toEqual(["icon", "alert-body"]);
    expect(host.querySelector("[data-slot=alert-body]")!.textContent).toBe("Couldn't saveTry again.");
  });

  it("never mistakes a title for an icon", async () => {
    await act(async () => root.render(
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
      </Alert>,
    ));
    expect(parts()).toEqual(["alert-body"]);
  });
});
