// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Tabs", () => {
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

  it("points a trigger only at a panel element that exists", () => {
    act(() => root.render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    ));
    const [a, b] = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const controlled = a!.getAttribute("aria-controls");
    expect(controlled && document.getElementById(controlled)?.textContent).toBe("Panel A");
    const other = b!.getAttribute("aria-controls");
    expect(other === null || document.getElementById(other) !== null).toBe(true);
  });

  it("leaves a filter's tabs without aria-controls (no panels)", () => {
    act(() => root.render(
      <Tabs value="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
        </TabsList>
      </Tabs>,
    ));
    for (const tab of host.querySelectorAll("[role=tab]")) expect(tab.hasAttribute("aria-controls")).toBe(false);
  });
});
