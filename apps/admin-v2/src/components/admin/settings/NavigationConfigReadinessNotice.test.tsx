// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NavigationConfigReadinessNotice } from "./NavigationConfigReadinessNotice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("NavigationConfigReadinessNotice", () => {
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

  it("asks for one explicit save after safe legacy normalization", () => {
    act(() => root.render(
      <NavigationConfigReadinessNotice
        section="header"
        readiness={{ state: "legacy_normalized" }}
      />,
    ));

    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.textContent).toContain("Save navigation update");
    expect(host.textContent).toContain("save this section once");
  });

  it("locks only the invalid section and explains why", () => {
    act(() => root.render(
      <NavigationConfigReadinessNotice
        section="footer"
        readiness={{ state: "invalid" }}
      />,
    ));

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain("Footer editing locked");
    expect(host.textContent).toContain("other settings remain available");
  });

  it("renders nothing for a ready section", () => {
    act(() => root.render(
      <NavigationConfigReadinessNotice
        section="header"
        readiness={{ state: "ready" }}
      />,
    ));

    expect(host.innerHTML).toBe("");
  });
});
