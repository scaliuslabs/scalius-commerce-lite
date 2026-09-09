// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocationFormDialog } from "./LocationFormDialog";
import type { LocationFormData } from "./hooks/useDeliveryLocations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialForm: LocationFormData = {
  name: "",
  parentId: "",
  externalIds: {},
  isActive: true,
};

let focusBeforeOpen: Element | null = null;

function Harness() {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState(initialForm);
  const fallbackRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          focusBeforeOpen = document.activeElement;
          openerRef.current = event.currentTarget;
          setOpen(true);
        }}
      >
        Add city
      </button>
      <button ref={fallbackRef} type="button">Add another location</button>
      <LocationFormDialog
        open={open}
        onClose={() => setOpen(false)}
        activeTab="city"
        editMode={false}
        formData={formData}
        setFormData={setFormData}
        isSubmitting={false}
        parentLocations={[]}
        loadingParents={false}
        onSubmit={(event) => event.preventDefault()}
        openerRef={openerRef}
        fallbackFocusRef={fallbackRef}
      />
    </>
  );
}

describe("LocationFormDialog focus return", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it.each(["Cancel", "Escape"])("returns focus to the opener after %s", async (closeMethod) => {
    const opener = host.querySelector<HTMLButtonElement>("button")!;
    const priorInput = document.createElement("input");
    host.append(priorInput);
    priorInput.focus();
    act(() => opener.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(focusBeforeOpen).toBe(priorInput);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    if (closeMethod === "Cancel") {
      const cancel = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Cancel",
      )!;
      act(() => cancel.click());
    } else {
      act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })));
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("uses the persistent add action when the edited row disappears", async () => {
    const opener = host.querySelector<HTMLButtonElement>("button")!;
    act(() => opener.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    opener.remove();
    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement?.textContent).toBe("Add another location");
    // Restore the React-owned node before unmounting the harness.
    host.prepend(opener);
  });

});
