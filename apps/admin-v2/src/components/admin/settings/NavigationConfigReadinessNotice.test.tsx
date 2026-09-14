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
        readiness={{
          status: "incomplete",
          issues: [{
            code: "navigation.legacy_normalized",
            message: "Existing header links were safely converted.",
          }],
        }}
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
        readiness={{
          status: "error",
          issues: [{
            code: "navigation.invalid",
            message: "The saved footer could not be read.",
          }],
        }}
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
        readiness={{ status: "ready", issues: [] }}
      />,
    ));

    expect(host.innerHTML).toBe("");
  });
});
