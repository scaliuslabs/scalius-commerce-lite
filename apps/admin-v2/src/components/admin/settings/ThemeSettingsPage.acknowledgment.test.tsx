// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME_SETTINGS, type StorefrontThemeSettings } from "@scalius/shared/storefront-theme";
import type { ThemeDraftPayload, ThemeWorkspacePayload } from "~/lib/api-functions/settings";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import ThemeSettingsPage from "./ThemeSettingsPage";
import type { ThemeWorkspaceSection } from "./theme-workspace";

const api = vi.hoisted(() => ({
  get: vi.fn(), save: vi.fn(), publish: vi.fn(), rebase: vi.fn(), restore: vi.fn(), history: vi.fn(),
  preview: vi.fn(), prepare: vi.fn(), submitPreview: vi.fn(), close: vi.fn(), blocker: vi.fn(), permission: vi.fn(),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getThemeWorkspace: api.get, saveThemeDraft: api.save, publishThemeDraft: api.publish,
  rebaseThemeDraft: api.rebase, rollbackTheme: api.restore, getThemeVersions: api.history,
  createThemePreviewSession: api.preview,
}));
vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: api.permission }) }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: { storefrontUrl: "https://shop.example.test" } }),
}));
vi.mock("./theme-preview-window", () => ({ prepareThemePreviewWindow: api.prepare, submitThemePreview: api.submitPreview }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base = DEFAULT_STOREFRONT_THEME_SETTINGS;
const headingTheme = (heading: StorefrontThemeSettings["typography"]["heading"]) => ({
  ...base, typography: { ...base.typography, heading },
});
const editorial = headingTheme("editorial");
function workspace(theme = base, draftRevision = 7, publishedRevision = 4): ThemeWorkspacePayload {
  return {
    published: { theme: base, revision: publishedRevision },
    draft: { theme, revision: draftRevision, basePublishedRevision: publishedRevision, updatedAt: null },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("ThemeSettingsPage operation acknowledgments", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    api.get.mockResolvedValue(workspace());
    api.permission.mockReturnValue(true);
    api.blocker.mockReturnValue({ status: "idle" });
    api.prepare.mockReturnValue({ close: api.close });
    api.preview.mockResolvedValue({ continuation: "test-continuation" });
    api.history.mockResolvedValue({ versions: [{
      id: "theme_2", revision: 2, theme: headingTheme("modern"), source: "publish", sourceRevision: null,
      publishedBy: null, createdAt: 1_700_000_000,
    }] });
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });
  async function render(initial = workspace()) {
    api.get.mockResolvedValueOnce(initial);
    function Harness() {
      const [section, setSection] = useState<ThemeWorkspaceSection>("system");
      return <ThemeSettingsPage section={section} onSectionChange={setSection} />;
    }
    await act(async () => { root.render(<Harness />); });
  }
  function button(text: string) {
    return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.textContent?.trim() === text)!;
  }
  async function click(target: HTMLElement) { await act(async () => { target.click(); }); }
  async function choice(label: string, value: string) {
    const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(async () => { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  async function color(label: string, value: string) {
    const field = host.querySelector<HTMLInputElement>(`[aria-label="${label} color value"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return field;
  }
  function heading() { return host.querySelector<HTMLSelectElement>('select[aria-label="Headings"]')!.value; }
  function expectProgress(label: string) {
    expect(host.querySelector('[data-testid="theme-action-bar"] [role="status"]')?.textContent).toBe(label);
    expect(host.querySelector('[data-testid="theme-primary-actions"]')?.getAttribute("aria-busy")).toBe("true");
  }
  async function save() { await click(host.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!); }
  async function menuAction(label: string) {
    await act(async () => {
      host.querySelector('[aria-label="More theme actions"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await click(Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.trim() === label)!);
  }
  async function discard() { await menuAction("Discard tab changes"); }
  async function startSave() {
    const pending = deferred<ThemeDraftPayload>();
    api.save.mockReturnValueOnce(pending.promise);
    await render();
    await choice("Headings", "editorial");
    await save();
    return pending;
  }
  async function conflict(pending: ReturnType<typeof deferred<ThemeDraftPayload>>, latest = workspace(editorial, 8)) {
    api.get.mockResolvedValueOnce(latest);
    await act(async () => { pending.reject(new AdminApiResponseError("Theme changed", 409)); });
    expect(button("Use latest")).toBeDefined();
  }

  it.each(["modern", "system"])("keeps the later %s heading after save and uses the acknowledged revision next", async (later) => {
    const pending = await startSave();
    await choice("Headings", later);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Saving theme draft"]')?.disabled).toBe(true);
    expectProgress("Saving…");
    await click(button("Colors"));
    expectProgress("Saving…");
    await click(button("Design system"));
    await act(async () => { pending.resolve(workspace(editorial, 8).draft); });
    expect(heading()).toBe(later);
    expect(host.textContent).toContain("Draft r8 · unsaved");
    api.save.mockResolvedValueOnce(workspace(headingTheme(later as "modern" | "system"), 9).draft);
    await save();
    expect(api.save.mock.calls.at(-1)![0].data).toMatchObject({ expectedDraftRevision: 8, basePublishedRevision: 4 });
    expect(host.textContent).toContain("Draft r9 · saved");
  });

  it.each(["#12", ""])("preserves the later raw color %j, including clearing an override", async (laterColor) => {
    const pending = deferred<ThemeDraftPayload>();
    api.save.mockReturnValueOnce(pending.promise);
    const initial = { ...base, colors: { border: "#123456" } };
    await render(workspace(initial));
    await choice("Headings", "editorial");
    await save();
    await click(button("Colors"));
    const field = await color("Border", laterColor);
    await act(async () => { pending.resolve(workspace({ ...editorial, colors: initial.colors }, 8).draft); });
    expect(field.value).toBe(laterColor);
    expect(host.textContent).toContain("Draft r8 · unsaved");
    expect(field.getAttribute("aria-invalid")).toBe(String(laterColor !== ""));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!.disabled).toBe(laterColor !== "");
  });

  it("keeps later edits and the old baseline after ordinary failure", async () => {
    const pending = await startSave();
    await choice("Headings", "modern");
    await act(async () => { pending.reject(new Error("Unavailable")); });
    expect(heading()).toBe("modern");
    expect(host.textContent).toContain("Draft r7 · unsaved");
    await discard();
    expect(heading()).toBe("system");
  });

  it("rebases both earlier edits and a post-submit revert, then preserves edits during Rebase", async () => {
    const pending = deferred<ThemeDraftPayload>();
    api.save.mockReturnValueOnce(pending.promise);
    await render();
    await choice("Headings", "editorial");
    await choice("Density", "compact");
    await save();
    await choice("Headings", "system");
    const latest = workspace({ ...editorial, containerWidth: "wide" }, 8);
    await conflict(pending, latest);
    const rebase = deferred<ThemeDraftPayload>();
    api.rebase.mockReturnValueOnce(rebase.promise);
    await click(button("Rebase mine"));
    expectProgress("Rebasing…");
    const submitted = api.rebase.mock.calls[0]![0].data;
    expect(submitted).toMatchObject({
      expectedDraftRevision: 8, theme: { typography: { heading: "system" }, density: "compact", containerWidth: "wide" },
    });
    await choice("Headings", "modern");
    await act(async () => { rebase.resolve(workspace(submitted.theme, 9).draft); });
    expect(heading()).toBe("modern");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Content width"]')?.value).toBe("wide");
    expect(host.textContent).toContain("Draft r9 · unsaved");
  });

  it("protects an unresolved reverted conflict and keeps Use latest explicit", async () => {
    const pending = await startSave();
    await choice("Headings", "system");
    await conflict(pending);
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    expect(heading()).toBe("system");
    await click(button("Review & publish"));
    const preview = button("Preview draft");
    expect(preview.disabled).toBe(true);
    await click(preview);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledTimes(1);
    await click(button("Design system"));
    await click(button("Use latest"));
    expect(heading()).toBe("editorial");
    expect(host.textContent).toContain("Draft r8 · saved");
  });

  it("preserves unresolved conflict intent through a failed read, later revert, and explicit Retry", async () => {
    const pending = await startSave();
    await choice("Headings", "system");
    const read = deferred<ThemeWorkspacePayload>();
    api.get.mockReturnValueOnce(read.promise);
    await act(async () => { pending.reject(new AdminApiResponseError("Changed", 409)); });
    await choice("Headings", "modern");
    await act(async () => { read.reject(new Error("Offline")); });
    await choice("Headings", "system");
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(true);
    expect(host.querySelector('[aria-label="Save draft"]')).toBeNull();
    await click(button("Review & publish"));
    expect(button("Preview draft").disabled).toBe(true);
    expect(button("Restore").disabled).toBe(true);
    await click(button("Design system"));
    const retry = deferred<ThemeWorkspacePayload>();
    api.get.mockReturnValueOnce(retry.promise);
    await click(button("Retry"));
    expect(button("Retrying…").disabled).toBe(true);
    expectProgress("Retrying…");
    await choice("Density", "compact");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!.disabled).toBe(true);
    await act(async () => { retry.resolve(workspace({ ...editorial, containerWidth: "wide" }, 8)); });
    expect(heading()).toBe("system");
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 9).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls[0]![0].data).toMatchObject({
      expectedDraftRevision: 8,
      theme: { typography: { heading: "system" }, density: "compact", containerWidth: "wide" },
    });
    expect(host.textContent).toContain("Draft r9 · saved");
  });

  it("checks merged color contrast before writing and retains the current draft for correction", async () => {
    const initial = { ...base, colors: { primary: "#000000", "primary-foreground": "#ffffff" } };
    const pending = deferred<ThemeDraftPayload>();
    api.save.mockReturnValueOnce(pending.promise);
    await render(workspace(initial));
    await click(button("Colors"));
    const field = await color("Primary", "#767676");
    await save();
    expect(api.save).toHaveBeenCalledTimes(1);
    await conflict(pending, workspace({ ...initial, colors: { ...initial.colors, "primary-foreground": "#bbbbbb" } }, 8));
    expect(button("Rebase mine").disabled).toBe(false);
    await click(button("Rebase mine"));
    expect(api.rebase).not.toHaveBeenCalled();
    expect(field.value).toBe("#767676");
    expect(host.textContent).toContain("Merged colors need attention: On primary / Primary");
    expect(button("Use latest")).toBeDefined();
    await color("Primary", "#333333");
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 9).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls[0]![0].data.theme.colors).toEqual({ primary: "#333333", "primary-foreground": "#bbbbbb" });
    expect(host.textContent).toContain("Draft r9 · saved");
  });

  it.each([false, true])("retains original conflict intent after Rebase failure; another conflict=%s", async (conflictedAgain) => {
    const pending = await startSave();
    await choice("Density", "compact");
    await choice("Headings", "system");
    await conflict(pending);
    const rebase = deferred<ThemeDraftPayload>();
    api.rebase.mockReturnValueOnce(rebase.promise);
    await click(button("Rebase mine"));
    expect(button("Use latest").disabled).toBe(true);
    await choice("Body text", "modern");
    if (conflictedAgain) api.get.mockResolvedValueOnce(workspace({ ...editorial, containerWidth: "wide" }, 9));
    await act(async () => {
      rebase.reject(conflictedAgain ? new AdminApiResponseError("Changed again", 409) : new Error("Offline"));
    });
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 10).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls.at(-1)![0].data).toMatchObject({
      expectedDraftRevision: conflictedAgain ? 9 : 8,
      theme: { typography: { heading: "system", body: "modern" }, density: "compact", containerWidth: conflictedAgain ? "wide" : base.containerWidth },
    });
    expect(heading()).toBe("system");
    expect(host.textContent).toContain("Draft r10 · saved");
  });

  it("keeps Discard explicit during conflict without replaying discarded submitted edits", async () => {
    const pending = await startSave();
    await choice("Density", "compact");
    await conflict(pending, workspace({ ...base, containerWidth: "wide" }, 8));
    await discard();
    expect(heading()).toBe("system");
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 9).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls[0]![0].data.theme).toEqual({ ...base, containerWidth: "wide" });
  });

  it("treats Restore store defaults as an explicit replacement before rebasing", async () => {
    const initial = { ...headingTheme("modern"), density: "compact" as const };
    const pending = deferred<ThemeDraftPayload>();
    api.save.mockReturnValueOnce(pending.promise);
    await render(workspace(initial));
    await choice("Headings", "editorial");
    await save();
    await conflict(pending, workspace({ ...editorial, density: "compact", containerWidth: "wide" }, 8));
    await menuAction("Restore store defaults");
    expect(heading()).toBe("system");
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 9).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls[0]![0].data.theme).toEqual({ ...base, containerWidth: "wide" });
  });

  it("publishes the saved snapshot while preserving edits during both response stages", async () => {
    const savePending = deferred<ThemeDraftPayload>();
    const publishPending = deferred<ThemeWorkspacePayload>();
    api.save.mockReturnValueOnce(savePending.promise);
    api.publish.mockReturnValueOnce(publishPending.promise);
    await render();
    await choice("Headings", "editorial");
    await click(button("Publish"));
    await choice("Headings", "system");
    expect(button("Publishing…")?.disabled).toBe(true);
    expectProgress("Publishing…");
    await act(async () => { savePending.resolve(workspace(editorial, 8).draft); });
    expect(button("Publishing…")?.disabled).toBe(true);
    expectProgress("Publishing…");
    expect(heading()).toBe("system");
    expect(api.publish).toHaveBeenCalledWith({ data: { expectedPublishedRevision: 4, expectedDraftRevision: 8 } });
    await choice("Headings", "modern");
    await act(async () => {
      publishPending.resolve({ ...workspace(editorial, 9, 5), published: { theme: editorial, revision: 5 } });
    });
    expect(heading()).toBe("modern");
    expect(host.textContent).toContain("Published r5");
    expect(host.textContent).toContain("Draft r9 · unsaved");
    await discard();
    expect(heading()).toBe("editorial");
  });

  it.each([false, true])("retains newer edits through preview with session failure=%s", async (failure) => {
    const savePending = deferred<ThemeDraftPayload>();
    const previewPending = deferred<{ continuation: string }>();
    api.save.mockReturnValueOnce(savePending.promise);
    api.preview.mockReturnValueOnce(previewPending.promise);
    await render();
    await choice("Headings", "editorial");
    await click(button("Preview"));
    await choice("Headings", "modern");
    await act(async () => { savePending.resolve(workspace(editorial, 8).draft); });
    expect(heading()).toBe("modern");
    expect(api.preview.mock.calls[0]![0].data.expectedDraftRevision).toBe(8);
    expectProgress("Opening…");
    await choice("Headings", "system");
    await act(async () => {
      if (failure) previewPending.reject(new Error("Preview unavailable"));
      else previewPending.resolve({ continuation: "test-continuation" });
    });
    expect(heading()).toBe("system");
    expect(host.textContent).toContain("Draft r8 · unsaved");
    expect(api.submitPreview).toHaveBeenCalledTimes(failure ? 0 : 1);
    expect(api.close).toHaveBeenCalledTimes(failure ? 1 : 0);
  });

  it.each(["Preview", "Publish"])("keeps the saved baseline and later revert when %s encounters a second-stage conflict", async (operation) => {
    const savePending = deferred<ThemeDraftPayload>();
    const nextPending = deferred<never>();
    api.save.mockReturnValueOnce(savePending.promise);
    (operation === "Preview" ? api.preview : api.publish).mockReturnValueOnce(nextPending.promise);
    await render();
    await choice("Headings", "editorial");
    await click(button(operation));
    await choice("Headings", "system");
    await act(async () => { savePending.resolve(workspace(editorial, 8).draft); });
    api.get.mockResolvedValueOnce(workspace({ ...editorial, density: "compact" }, 9));
    await act(async () => { nextPending.reject(new AdminApiResponseError("Changed after save", 409)); });
    expect(host.textContent).toContain("Draft r8 · unsaved");
    expect(host.textContent).toContain("Published r4");
    expect(heading()).toBe("system");
    api.rebase.mockImplementationOnce(async ({ data }) => workspace(data.theme, 10).draft);
    await click(button("Rebase mine"));
    expect(api.rebase.mock.calls[0]![0].data).toMatchObject({
      expectedDraftRevision: 9, theme: { typography: { heading: "system" }, density: "compact" },
    });
  });

  it("retains an acknowledged draft after Publish fails without advancing the published revision", async () => {
    const publishPending = deferred<ThemeWorkspacePayload>();
    api.save.mockResolvedValueOnce(workspace(editorial, 8).draft);
    api.publish.mockReturnValueOnce(publishPending.promise);
    await render();
    await choice("Headings", "editorial");
    await click(button("Publish"));
    await choice("Headings", "system");
    await act(async () => { publishPending.reject(new Error("Unavailable")); });
    expect(heading()).toBe("system");
    expect(host.textContent).toContain("Draft r8 · unsaved");
    expect(host.textContent).toContain("Published r4");
    await discard();
    expect(heading()).toBe("editorial");
  });

  it("allows a view-only user to preview an existing saved revision without writing", async () => {
    api.permission.mockReturnValue(false);
    await render();
    await click(button("Review & publish"));
    expect(button("Preview draft").disabled).toBe(false);
    await click(button("Preview draft"));
    expect(api.save).not.toHaveBeenCalled();
    expect(api.preview).toHaveBeenCalledWith({ data: { expectedDraftRevision: 7, path: "/", device: "desktop" } });
    expect(api.submitPreview).toHaveBeenCalledTimes(1);
    expect(button("Restore").disabled).toBe(true);
  });

  it("lets a view-only preview conflict recover through Use latest without offering Rebase", async () => {
    api.permission.mockReturnValue(false);
    const previewPending = deferred<never>();
    api.preview.mockReturnValueOnce(previewPending.promise);
    await render();
    await click(button("Preview"));
    api.get.mockResolvedValueOnce(workspace(editorial, 8));
    await act(async () => { previewPending.reject(new AdminApiResponseError("Draft changed", 409)); });
    expect(button("Rebase mine").disabled).toBe(true);
    await click(button("Rebase mine"));
    expect(api.rebase).not.toHaveBeenCalled();
    expect(button("Use latest").disabled).toBe(false);
    await click(button("Use latest"));
    await click(button("Preview"));
    expect(api.preview.mock.calls.at(-1)![0].data.expectedDraftRevision).toBe(8);
    expect(api.save).not.toHaveBeenCalled();
    expect(api.submitPreview).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("restores the confirmed revision and preserves only later edits: %s", async (editLater) => {
    const restorePending = deferred<ThemeWorkspacePayload>();
    api.restore.mockReturnValueOnce(restorePending.promise);
    await render();
    await choice("Headings", "editorial");
    await click(button("Review & publish"));
    await click(button("Restore"));
    await click(button("Restore as new revision"));
    expectProgress("Restoring…");
    await click(button("Design system"));
    expectProgress("Restoring…");
    if (editLater) await choice("Headings", "system");
    const restored = headingTheme("modern");
    await act(async () => {
      restorePending.resolve({ ...workspace(restored, 8, 5), published: { theme: restored, revision: 5 } });
    });
    expect(heading()).toBe(editLater ? "system" : "modern");
    expect(host.textContent).toContain(`Draft r8 · ${editLater ? "unsaved" : "saved"}`);
    expect(host.textContent).toContain("Published r5");
  });

  it("retains a bootstrap draft acknowledgment when restore fails", async () => {
    api.save.mockResolvedValueOnce(workspace(base, 1).draft);
    api.restore.mockRejectedValueOnce(new Error("Restore unavailable"));
    await render(workspace(base, 0));
    await choice("Headings", "editorial");
    await click(button("Review & publish"));
    await click(button("Restore"));
    await click(button("Restore as new revision"));
    await click(button("Design system"));
    expect(heading()).toBe("editorial");
    expect(host.textContent).toContain("Draft r1 · unsaved");
    api.save.mockResolvedValueOnce(workspace(editorial, 2).draft);
    await save();
    expect(api.save.mock.calls.at(-1)![0].data.expectedDraftRevision).toBe(1);
  });

  it("serializes Save and Review actions even before pending controls rerender", async () => {
    api.save.mockReturnValueOnce(new Promise(() => undefined));
    await render();
    await choice("Headings", "editorial");
    await click(button("Review & publish"));
    const saveButton = host.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!;
    const preview = button("Preview draft");
    await act(async () => { saveButton.click(); preview.click(); });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(preview.disabled).toBe(true);
    expect(button("Restore").disabled).toBe(true);
  });
});
