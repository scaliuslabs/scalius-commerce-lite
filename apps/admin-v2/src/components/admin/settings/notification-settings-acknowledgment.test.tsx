// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSettingsPayload, FirebaseSettingsPayload } from "~/lib/api-functions/settings";
import { queryKeys } from "~/lib/query-keys";
import EmailSettingsForm from "./EmailSettingsForm";
import FirebaseSettingsForm from "./FirebaseSettingsForm";

const api = vi.hoisted(() => ({
  email: vi.fn(), firebase: vi.fn(), updateEmail: vi.fn(), updateFirebase: vi.fn(), readiness: vi.fn(),
  blocker: vi.fn(), permission: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getEmailSettings: api.email, getFirebaseSettings: api.firebase,
  updateEmailSettings: api.updateEmail, updateFirebaseSettings: api.updateFirebase,
  getAdminNotificationChannels: api.readiness,
}));
vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: api.permission }) }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("sonner", () => ({ toast: { success: api.success, warning: api.warning, error: api.error } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mask = "••••••••••••";
const emailBase: EmailSettingsPayload = {
  provider: "resend", apiKey: mask, sender: "before@example.test", senderConfigured: true,
  cloudflareBindingConfigured: true, resendConfigured: true, ready: true, readinessError: null,
};
const firebaseBase: FirebaseSettingsPayload = {
  serviceAccount: mask,
  publicConfig: { apiKey: "public-test-key", authDomain: "example.test", projectId: "before",
    storageBucket: "before.example.test", messagingSenderId: "123456", appId: "before-app", measurementId: "", vapidKey: "public-vapid" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const kind of ["email", "firebase"] as const) describe(`${kind} settings acknowledgment`, () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let storedEmail: EmailSettingsPayload;
  let storedFirebase: FirebaseSettingsPayload;
  const queryKey = kind === "email" ? queryKeys.settings.email() : queryKeys.settings.firebase();
  const read = kind === "email" ? api.email : api.firebase;
  const update = kind === "email" ? api.updateEmail : api.updateFirebase;
  const mainId = kind === "email" ? "email-sender" : "firebase-projectId";
  const credentialId = kind === "email" ? "resend-api-key" : "firebase-service-account";
  const after = kind === "email" ? "after@example.test" : "after";
  const later = kind === "email" ? "later@example.test" : "later";
  const stored = () => kind === "email" ? storedEmail : storedFirebase;
  const mainStored = () => kind === "email" ? storedEmail.sender : storedFirebase.publicConfig.projectId;

  beforeEach(() => {
    vi.resetAllMocks();
    storedEmail = structuredClone(emailBase);
    storedFirebase = structuredClone(firebaseBase);
    api.email.mockImplementation(async () => structuredClone(storedEmail));
    api.firebase.mockImplementation(async () => structuredClone(storedFirebase));
    api.readiness.mockResolvedValue({ pushConfigured: true, pushError: null });
    api.updateEmail.mockImplementation(async ({ data }) => {
      storedEmail = { ...storedEmail, ...data, apiKey: "apiKey" in data ? data.apiKey ? mask : "" : storedEmail.apiKey };
      return { message: "Saved" };
    });
    api.updateFirebase.mockImplementation(async ({ data }) => {
      storedFirebase = { ...storedFirebase, ...data, publicConfig: structuredClone(data.publicConfig), serviceAccount: "serviceAccount" in data ? data.serviceAccount ? mask : "" : storedFirebase.serviceAccount };
      return { message: "Saved" };
    });
    api.blocker.mockReturnValue({ status: "idle" });
    api.permission.mockReturnValue(true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKey, structuredClone(stored()), { updatedAt: 1 });
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}>
      {kind === "email" ? <EmailSettingsForm /> : <FirebaseSettingsForm />}
    </QueryClientProvider>));
    await settle();
  }
  function input(id = mainId) { return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!; }
  function button(label: string) { return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.trim() === label)!; }
  async function click(node: HTMLElement) { await act(async () => { node.click(); }); await settle(); }
  async function type(value: string, id = mainId) {
    const node = input(id);
    await act(async () => {
      Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function failRefreshAfterSave() {
    await render(); await type(after);
    read.mockRejectedValue(new Error("Settings read unavailable"));
    await click(button("Save changes"));
  }

  it("ignores a pre-acknowledgment background snapshot whose effect runs after the committed write", async () => {
    await render(); await type(after);
    const saving = deferred<{ message: string }>();
    update.mockReturnValueOnce(saving.promise);
    await click(button("Save changes"));
    const background = deferred<EmailSettingsPayload | FirebaseSettingsPayload>();
    read.mockReturnValueOnce(background.promise).mockRejectedValueOnce(new Error("Confirming read failed"));
    act(() => { void client.refetchQueries({ queryKey }); }); await settle();
    await act(async () => {
      background.resolve(structuredClone(stored()));
      await Promise.resolve();
      if (kind === "email") storedEmail.sender = after;
      else storedFirebase.publicConfig.projectId = after;
      saving.resolve({ message: "Saved" });
    }); await settle();
    expect(mainStored()).toBe(after);
    expect(input().value).toBe(after);
    expect(host.textContent).toContain("could not be refreshed");
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(false);
    await click(button("Retry"));
    expect(input().value).toBe(after);
    expect(host.textContent).not.toContain("could not be refreshed");
    if (kind === "email") storedEmail.sender = later;
    else storedFirebase.publicConfig.projectId = later;
    await act(async () => { await client.refetchQueries({ queryKey }); }); await settle();
    expect(input().value).toBe(later);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(false);
  });

  it("keeps the submitted values and credential clear after a committed save cannot refresh", async () => {
    await render(); await type(after); await type("", credentialId);
    const confirmingRead = deferred<EmailSettingsPayload | FirebaseSettingsPayload>();
    read.mockReturnValueOnce(confirmingRead.promise);
    await click(button("Save changes"));
    expect(mainStored()).toBe(after);
    expect(button("Save changes").disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    await act(async () => { confirmingRead.reject(new Error("Settings read unavailable")); }); await settle();
    expect(input().value).toBe(after);
    expect(input(credentialId).value).toBe("");
    expect(host.textContent).toContain("could not be refreshed");
    expect(button("Retry")).toBeDefined();
    expect(api.warning).toHaveBeenCalled();
    expect(api.error).not.toHaveBeenCalled();
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(false);
    read.mockImplementation(async () => structuredClone(stored()));
    if (kind === "email") {
      await click(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.includes("Cloudflare Email"))!);
    } else await type("later-app", "firebase-appId");
    await click(button("Save changes"));
    expect(mainStored()).toBe(after);
    const payload = update.mock.calls.at(-1)![0].data;
    expect(kind === "email" ? payload.sender : payload.publicConfig.projectId).toBe(after);
  });

  it("preserves later edits and merges untouched fields when Retry succeeds", async () => {
    await failRefreshAfterSave();
    expect(input().value).toBe(after);
    const retry = deferred<EmailSettingsPayload | FirebaseSettingsPayload>();
    read.mockReturnValueOnce(retry.promise);
    await click(button("Retry"));
    await type(later);
    expect(input().disabled).toBe(false);
    expect(button("Save changes").disabled).toBe(true);
    if (kind === "email") storedEmail.provider = "cloudflare";
    else storedFirebase.publicConfig.appId = "remote-app";
    await act(async () => { retry.resolve(structuredClone(stored())); }); await settle();
    expect(input().value).toBe(later);
    if (kind === "email") expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Cloudflare Email");
    else expect(input("firebase-appId").value).toBe("remote-app");
    expect(host.textContent).not.toContain("could not be refreshed");
    expect(button("Save changes").disabled).toBe(false);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    await click(button("Reset"));
    expect(input().value).toBe(after);
  });

  it("keeps failed Retry feedback and prevents overlapping Save and Retry commands", async () => {
    await failRefreshAfterSave(); await type(later);
    await click(button("Retry"));
    expect(input().value).toBe(later);
    expect(host.textContent).toContain("could not be refreshed");
    const retry = deferred<EmailSettingsPayload | FirebaseSettingsPayload>();
    read.mockReturnValueOnce(retry.promise);
    const retryButton = button("Retry"); const saveButton = button("Save changes");
    await act(async () => { retryButton.click(); saveButton.click(); retryButton.click(); }); await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { retry.resolve(structuredClone(stored())); }); await settle();
    const savePending = deferred<{ message: string }>(); update.mockReturnValueOnce(savePending.promise);
    await act(async () => { saveButton.click(); saveButton.click(); }); await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(input().disabled).toBe(true);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    await act(async () => { savePending.reject(new Error("Rejected")); }); await settle();
  });

  it("adopts confirmed credential masking even when refetch structurally shares the old cache", async () => {
    await render();
    const original = client.getQueryData(queryKey);
    const originalUpdatedAt = client.getQueryState(queryKey)!.dataUpdatedAt;
    vi.spyOn(Date, "now").mockReturnValue(originalUpdatedAt);
    await type(kind === "email" ? "new-local-test-key" : JSON.stringify({ private_key: "local-test-key", client_email: "local@example.test", project_id: "local-test" }), credentialId);
    await click(button("Save changes"));
    expect(client.getQueryData(queryKey)).toBe(original);
    expect(client.getQueryState(queryKey)!.dataUpdatedAt).toBe(originalUpdatedAt);
    expect(input(credentialId).value).toBe(mask);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(false);
    expect(api.success).toHaveBeenCalled();
  });

  it("retains draft and baseline when the write itself fails", async () => {
    await render(); await type(after);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    update.mockRejectedValueOnce(new Error("Write rejected"));
    await click(button("Save changes"));
    expect(input().value).toBe(after);
    expect(button("Save changes").disabled).toBe(false);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(api.error).toHaveBeenCalled();
    await click(button("Reset"));
    expect(input().value).toBe(kind === "email" ? emailBase.sender : firebaseBase.publicConfig.projectId);
  });

  it("updates clean fields during a background refresh without losing a dirty field", async () => {
    await render(); await type(after);
    if (kind === "email") storedEmail.provider = "cloudflare";
    else storedFirebase.publicConfig.appId = "remote-app";
    await act(async () => client.setQueryData(queryKey, structuredClone(stored()), { updatedAt: 2 })); await settle();
    expect(input().value).toBe(after);
    if (kind === "email") expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Cloudflare Email");
    else expect(input("firebase-appId").value).toBe("remote-app");
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a successful settings refresh distinct from dependent readiness failure", async () => {
    await render(); await type(after);
    const dependentKey = kind === "email" ? queryKeys.settings.auth() : queryKeys.settings.adminNotificationChannels();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    if (kind === "firebase") api.readiness.mockRejectedValue(new Error("Readiness unavailable"));
    await click(button("Save changes"));
    expect(input().value).toBe(after);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: dependentKey }));
    expect(host.textContent).not.toContain("could not be refreshed");
    expect(api.success).toHaveBeenCalled();
    if (kind === "firebase") {
      expect(host.textContent).toContain("Server unavailable");
      expect(button("Retry")).toBeDefined();
      api.readiness.mockResolvedValue({ pushConfigured: true, pushError: null });
      await click(button("Retry"));
      expect(host.textContent).toContain("Push configured");
      expect(host.textContent).not.toContain("Provider status could not be checked");
      expect(input().value).toBe(after);
    }
  });

  if (kind === "firebase") it("recovers settings and readiness together after both post-save reads fail", async () => {
    await render(); await type(after);
    read.mockRejectedValue(new Error("Settings read unavailable"));
    api.readiness.mockRejectedValue(new Error("Readiness unavailable"));
    await click(button("Save changes"));
    expect(host.textContent).toContain("Push status unavailable");
    expect(host.textContent).toContain("Provider status could not be checked");
    expect(Array.from(host.querySelectorAll("button")).filter(node => node.textContent === "Retry")).toHaveLength(1);
    read.mockImplementation(async () => structuredClone(stored()));
    const readiness = deferred<{ pushConfigured: boolean; pushError: null }>();
    api.readiness.mockReturnValueOnce(readiness.promise);
    await click(button("Retry")); await type(later);
    expect(host.textContent).toContain("Checking push status…");
    expect(button("Save changes").disabled).toBe(true);
    await act(async () => { readiness.resolve({ pushConfigured: true, pushError: null }); }); await settle();
    expect(host.textContent).toContain("Push configured");
    expect(host.textContent).not.toContain("unavailable");
    expect(input().value).toBe(later);
    expect(button("Save changes").disabled).toBe(false);
  });

  it("allows read-only refresh recovery without enabling writes", async () => {
    api.permission.mockReturnValue(false); await render();
    read.mockRejectedValueOnce(new Error("Read unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await settle();
    expect(button("Retry")).toBeDefined();
    expect(input().disabled).toBe(true);
    read.mockImplementation(async () => structuredClone(stored()));
    await click(button("Retry"));
    expect(host.textContent).not.toContain("could not be refreshed");
    expect(input().disabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});
