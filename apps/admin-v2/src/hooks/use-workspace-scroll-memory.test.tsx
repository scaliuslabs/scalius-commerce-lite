// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceScrollMemory } from "./use-workspace-scroll-memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("useWorkspaceScrollMemory", () => {
  let container: HTMLDivElement;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    container = document.createElement("div");
    container.id = "admin-main-scroll";
    host = document.createElement("div");
    container.append(host);
    document.body.append(container);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function Harness() {
    const [workspace, setWorkspace] = useState("seo");
    const rememberWorkspaceScroll = useWorkspaceScrollMemory(workspace);

    const changeWorkspace = (next: string) => {
      rememberWorkspaceScroll();
      setWorkspace(next);
    };

    return (
      <>
        <span>{workspace}</span>
        <button type="button" onClick={() => changeWorkspace("seo")}>
          SEO
        </button>
        <button type="button" onClick={() => changeWorkspace("currency")}>
          Currency
        </button>
      </>
    );
  }

  it("restores each mounted workspace after its content becomes active", () => {
    act(() => root.render(<Harness />));

    container.scrollTop = 600;
    const currency = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Currency",
    );
    if (!currency) throw new Error("Expected Currency button");

    act(() => currency.click());
    expect(container.scrollTop).toBe(0);

    container.scrollTop = 80;
    const seo = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "SEO",
    );
    if (!seo) throw new Error("Expected SEO button");

    act(() => seo.click());
    expect(container.scrollTop).toBe(600);
  });
});
