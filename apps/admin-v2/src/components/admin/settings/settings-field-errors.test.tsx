// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { SaveErrorBanner, SaveScope, useSaveBar, type SaveScopeState } from "../shared/SaveBar";
import { SettingsField } from "./SettingsPage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What the API sends when a request body fails validation.
const rejection = new AdminApiResponseError(JSON.stringify([
  { origin: "string", code: "invalid_format", format: "email", path: ["email"], message: "Invalid email address" },
  { code: "custom", path: ["legacyField"], message: "Not allowed here" },
]), 400);

function BusinessForm() {
  const [email, setEmail] = useState("owner@");
  useSaveBar({
    dirty: true,
    label: "Store name and contact",
    fields: (path) => `business-${path}`,
    save: async () => { throw rejection; },
    discard: () => {},
  });
  return (
    <SettingsField id="business-email" label="Email">
      <input id="business-email" value={email} onChange={(event) => setEmail(event.target.value)} />
    </SettingsField>
  );
}

function FeeForm() {
  const [fee, setFee] = useState("");
  const invalid = fee.trim() === "" || Number(fee) < 0;
  useSaveBar({ dirty: true, invalid, save: async () => {}, discard: () => {} });
  return (
    <SettingsField id="rate-fee" label="Charge" error={invalid ? "Enter 0 or more." : null}>
      <input id="rate-fee" value={fee} aria-invalid={invalid} onChange={(event) => setFee(event.target.value)} />
    </SettingsField>
  );
}

describe("inline validation", () => {
  it("stays quiet while typing, shows on leaving the field, and Save reveals and focuses it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let scope: SaveScopeState | null = null;
    act(() => {
      root.render(
        <SaveScope render={(next) => { scope = next; return null; }}>
          <SaveErrorBanner />
          <FeeForm />
        </SaveScope>,
      );
    });
    const input = container.querySelector<HTMLInputElement>("#rate-fee")!;
    // Not yet left: no message, and the field isn't red either.
    expect(container.querySelector("#rate-fee-note")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");

    // Pressing Save reveals the problem and puts the cursor there; nothing is saved.
    let saved = true;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(container.querySelector("#rate-fee-note")?.textContent).toBe("Enter 0 or more.");
    expect(document.activeElement).toBe(input);
    act(() => root.unmount());

    // Passing through the empty field flags nothing; leaving it after typing does.
    const again = createRoot(container);
    act(() => {
      again.render(
        <SaveScope render={() => null}>
          <FeeForm />
        </SaveScope>,
      );
    });
    const field = container.querySelector<HTMLInputElement>("#rate-fee")!;
    act(() => { field.focus(); field.blur(); });
    expect(container.querySelector("#rate-fee-note")).toBeNull();
    act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "-1");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.blur();
    });
    expect(container.querySelector("#rate-fee-note")?.textContent).toBe("Enter 0 or more.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Emptying it again keeps the message: the merchant did type here.
    act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.blur();
    });
    expect(container.querySelector("#rate-fee-note")?.textContent).toBe("Enter 0 or more.");
    act(() => again.unmount());
    container.remove();
  });
});

describe("inline validation of a picker", () => {
  it("keeps the hint while the merchant opens the list without choosing (Add staff → Role)", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SettingsField id="staff-role" label="Role" error="Choose a role." help="You can only give access you have.">
          <button type="button" id="staff-role">Choose a role</button>
        </SettingsField>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("#staff-role")!;
    act(() => { trigger.focus(); trigger.blur(); });
    expect(container.querySelector("#staff-role-note")?.textContent).toBe("You can only give access you have.");
    act(() => root.unmount());
    container.remove();
  });
});

describe("inline validation of a saved value", () => {
  it("flags a filled-in value the merchant only tabbed through", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SettingsField id="store-phone" label="Phone" error="Enter a phone number like 01712-345678.">
          <input id="store-phone" defaultValue="12345" />
        </SettingsField>,
      );
    });
    const input = container.querySelector<HTMLInputElement>("#store-phone")!;
    act(() => { input.focus(); input.blur(); });
    expect(container.querySelector("#store-phone-note")?.textContent).toBe("Enter a phone number like 01712-345678.");
    act(() => root.unmount());
    container.remove();
  });
});

describe("server field errors", () => {
  it("marks the rejected field in place (once), lists the rest, focuses the field and clears on edit", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let scope: SaveScopeState | null = null;
    act(() => {
      root.render(
        <SaveScope render={(next) => { scope = next; return null; }}>
          <SaveErrorBanner />
          <BusinessForm />
        </SaveScope>,
      );
    });

    await act(async () => { await scope!.saveAll(); });
    const input = container.querySelector<HTMLInputElement>("#business-email")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector("#business-email-note")?.textContent).toBe("Enter an email address like name@example.com.");
    expect(document.activeElement).toBe(input);
    const banner = container.querySelector(".scroll-mt-4")!.textContent;
    // One indicator per field: the page banner counts it but doesn't repeat it.
    expect(banner).toContain("To save, fix 2 problems");
    expect(banner).not.toContain("Enter an email address");
    // An unplaceable path stays in the banner, named by its card.
    expect(banner).toContain("Store name and contact: Not allowed here");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "owner@shop.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector("#business-email-note")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});

describe("server field errors in a dialog", () => {
  it("shows a placed field error only next to the field, and no banner when nothing else went wrong", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let scope: SaveScopeState | null = null;
    function EmailOnly() {
      useSaveBar({
        dirty: true,
        fields: (path) => `business-${path}`,
        save: async () => {
          throw new AdminApiResponseError(JSON.stringify([
            { origin: "string", code: "invalid_format", format: "email", path: ["email"], message: "Invalid email address" },
          ]), 400);
        },
        discard: () => {},
      });
      return (
        <SettingsField id="business-email" label="Email">
          <input id="business-email" defaultValue="owner@" />
        </SettingsField>
      );
    }
    act(() => {
      root.render(
        <div role="dialog">
          <SaveScope render={(next) => { scope = next; return null; }}>
            <SaveErrorBanner />
            <EmailOnly />
          </SaveScope>
        </div>,
      );
    });

    let saved = true;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(false);
    expect(container.querySelector("#business-email-note")?.textContent).toBe("Enter an email address like name@example.com.");
    expect(container.querySelector(".scroll-mt-4")).toBeNull();
    expect(scope!.failed).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});
