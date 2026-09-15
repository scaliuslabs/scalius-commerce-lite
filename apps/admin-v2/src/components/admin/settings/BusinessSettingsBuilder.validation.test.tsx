// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const formState = vi.hoisted(() => ({
  values: {
    companyName: "Merchant",
    legalName: "",
    taxId: "",
    phone: "",
    email: "support@example.test",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateRegion: "",
    postalCode: "",
    country: "Bangladesh",
    invoicePrefix: "INV",
    invoiceLogoUrl: "",
    invoiceFooterText: "",
  },
  setValue: vi.fn(),
  isLoading: false,
  isLoaded: true,
  isLoadError: false,
  loadError: null,
  isSaving: false,
  isDirty: true,
  reset: vi.fn(),
  handleSubmit: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("~/hooks/use-settings-form", () => ({
  useSettingsForm: () => formState,
  getSettingsLoadErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getBusinessSettings: vi.fn(),
  updateBusinessSettings: vi.fn(),
}));
vi.mock("../shared/UnsavedChangesGuard", () => ({
  UnsavedChangesGuard: () => null,
}));
vi.mock("../media-manager", () => ({
  MediaManager: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

import BusinessSettingsBuilder from "./BusinessSettingsBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BusinessSettingsBuilder native email validation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render() {
    await act(async () => root.render(<BusinessSettingsBuilder />));
  }

  it("uses a native post form and blocks an invalid email before save", async () => {
    await render();
    const form = host.querySelector("form") as HTMLFormElement;
    const email = host.querySelector("#business-email") as HTMLInputElement;
    const save = host.querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(form.method).toBe("post");
    expect(email.name).toBe("email");
    expect(Array.from(form.querySelectorAll("button:not([type='submit'])"))
      .every((button) => (button as HTMLButtonElement).type === "button")).toBe(true);
    email.value = "support@";
    expect(email.checkValidity()).toBe(false);

    await act(async () => save.click());
    expect(formState.handleSubmit).not.toHaveBeenCalled();

    email.value = "support@example.test";
    await act(async () => save.click());
    expect(formState.handleSubmit).toHaveBeenCalledOnce();
  });
});
