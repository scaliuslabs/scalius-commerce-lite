// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./alert-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AlertDialogAction", () => {
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

  it("passes the selected Button variant through to the rendered action", async () => {
    await act(async () => root.render(
      <AlertDialog open onOpenChange={() => {}}>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <AlertDialogDescription>Review this action.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
            <AlertDialogAction>Keep</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    ));

    const [destructive, primary] = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    );
    expect(destructive?.className).toContain("from-destructive");
    expect(destructive?.className).toContain("text-destructive-foreground");
    expect(destructive?.className).not.toContain("from-primary");
    expect(primary?.className).toContain("from-primary");
  });
});
