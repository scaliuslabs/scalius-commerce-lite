// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DropdownMenuItem", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("tints a destructive item without changing what it does", async () => {
    await act(async () => root.render(
      <DropdownMenu open onOpenChange={() => {}}>
        <DropdownMenuContent>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    ));

    const [edit, remove] = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    expect(edit.getAttribute("data-variant")).toBe("default");
    expect(remove.getAttribute("data-variant")).toBe("destructive");
    // The tone is carried by the data attribute, so callers stop hand-rolling
    // their own destructive classes.
    expect(remove.className).toContain("data-[variant=destructive]:text-destructive");
    expect(edit.textContent).toBe("Edit");
  });
});
