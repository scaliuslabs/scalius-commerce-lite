// @vitest-environment happy-dom

import { act, cloneElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import type { LibraryMediaFile, MediaFile } from "../types";
import { MediaPreview } from "./MediaPreview";

vi.mock("./MediaUsage", () => ({ MediaUsage: () => <p>Saved file usage</p> }));
vi.mock("../LazyMediaManager", () => ({
  MediaManager: ({ trigger, onSelect }: { trigger: ReactElement<ComponentProps<"button">>; onSelect: (file: MediaFile) => void }) =>
    cloneElement(trigger, { onClick: () => onSelect({ id: "poster_1", filename: "cover.webp", url: "https://media.example/cover.webp", size: 100, createdAt: new Date(0) }) }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const media = (overrides: Partial<LibraryMediaFile> = {}): LibraryMediaFile => ({
  id: "image_1", filename: "portrait.webp", url: "https://media.example/portrait.webp", objectKey: "portrait.webp",
  kind: "image", mimeType: "image/webp", size: 100, width: 600, height: 1200,
  altText: null, caption: null, durationMs: null, posterMediaId: null, posterUrl: null, folderId: null,
  status: "ready", version: 1, createdAt: new Date(0), updatedAt: new Date(0), trashedAt: null, deletedAt: null,
  usageCount: 0, keptForOrders: false, ...overrides,
});
const video = (overrides: Partial<LibraryMediaFile> = {}) => media({
  id: "video_1", filename: "clip.mp4", kind: "video", mimeType: "video/mp4", url: "https://media.example/clip.mp4", ...overrides,
});
const t = (key: keyof typeof mediaMessages.en) => translate(mediaMessages, key);
const r = (key: keyof typeof resourceMessages.en) => translate(resourceMessages, key);
const onOpenChange = vi.fn();
const onNavigate = vi.fn();
const onUpdate = vi.fn<ComponentProps<typeof MediaPreview>["onUpdate"]>();
const onSelect = vi.fn();
let host: HTMLDivElement;
let root: Root;
let current: LibraryMediaFile;

beforeEach(() => {
  vi.resetAllMocks();
  setLocale("en");
  current = media();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setLocale("en");
});

async function render(file = current, picker = false) {
  current = file;
  await act(async () => root.render(<MediaPreview open file={file} files={[media({ id: "previous" }), file, media({ id: "next" })]}
    onOpenChange={onOpenChange} onNavigate={onNavigate} onUpdate={onUpdate} onSelect={picker ? onSelect : undefined} />));
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((element) => element.getAttribute("aria-label") === name || element.textContent?.trim() === name)!;
const save = () => button(r("save"));
const click = (name: string) => act(() => button(name).click());
async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("media preview drafts", () => {
  it.each(["en", "bn"] as const)("uses save normalization for dirty and revert in %s", async (locale) => {
    setLocale(locale);
    await render(media({ altText: "Portrait" }));
    expect(save().disabled).toBe(true);
    await type("media-filename", "  portrait.webp  ");
    await type("media-description", "  Portrait\n");
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(r("unsavedChanges"));
    await type("media-description", "Different portrait");
    expect(save().disabled).toBe(false);
    await type("media-description", "Portrait");
    expect(save().disabled).toBe(true);
    click(t("nextFile"));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("treats blank optional text and a null video cover as unchanged", async () => {
    await render(video());
    await type("media-description", "  \n ");
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain(t("noCoverImage"));
    click(r("close"));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("preserves an off-page cover and recognizes removing then restoring its exact ID", async () => {
    await render(video({ posterMediaId: "poster_1", posterUrl: "https://media.example/cover.webp" }));
    expect(save().disabled).toBe(true);
    expect(document.querySelector("video")?.getAttribute("poster")).toContain("cover.webp");
    click(t("remove"));
    expect(save().disabled).toBe(false);
    click(t("chooseCoverImage"));
    expect(save().disabled).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps close, navigation, selection and edits from racing a pending save", async () => {
    let release!: (file: LibraryMediaFile) => void;
    onUpdate.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await render(media(), true);
    await type("media-filename", "  renamed.webp  ");
    await type("media-description", "  Accessible portrait  ");
    await act(async () => { save().click(); save().click(); });
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(current, { filename: "renamed.webp", altText: "Accessible portrait" });
    expect(save().disabled).toBe(true);
    expect((document.getElementById("media-filename") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("media-description") as HTMLTextAreaElement).disabled).toBe(true);
    expect(button(t("previousFile")).disabled).toBe(true);
    expect(button(t("nextFile")).disabled).toBe(true);
    expect(button(t("useImage")).disabled).toBe(true);
    click(r("close"));
    click(t("nextFile"));
    click(t("useImage"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    const updated = media({ filename: "renamed.webp", altText: "Accessible portrait", version: 2 });
    await act(async () => release(updated));
    await render(updated, true);
    expect(save().disabled).toBe(true);
    expect((document.getElementById("media-filename") as HTMLInputElement).disabled).toBe(false);
    click(t("nextFile"));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("retains a refused save for retry and only discards after confirmation", async () => {
    onUpdate.mockRejectedValue(new Error("save refused"));
    await render();
    await type("media-description", "Keep this draft");
    await act(async () => save().click());
    expect(save().disabled).toBe(false);
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Keep this draft");
    click(t("nextFile"));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
    click(t("keepEditing"));
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Keep this draft");
    click(t("nextFile"));
    click(t("discardConfirm"));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(1);
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("");
  });

  it("resets from the save response even when its version did not change", async () => {
    await render();
    await type("media-filename", "  renamed.webp  ");
    const updated = media({ filename: "renamed.webp" });
    onUpdate.mockResolvedValue(updated);
    await act(async () => save().click());
    expect((document.getElementById("media-filename") as HTMLInputElement).value).toBe("renamed.webp");
    await render(updated);
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(r("unsavedChanges"));
  });

  it("asks before the picker uses a file with unsaved metadata", async () => {
    await render(media(), true);
    await type("media-description", "Keep this draft");
    click(t("useImage"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    click(t("keepEditing"));
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Keep this draft");
    click(t("useImage"));
    click(t("discardConfirm"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(current);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("resets image loading and errors per file and offers honest original access", async () => {
    await render();
    const first = document.querySelector<HTMLImageElement>('img[alt="portrait.webp"]')!;
    expect(document.querySelector('[role="status"]')?.textContent).toContain(r("loading"));
    await act(async () => first.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="status"]')?.textContent).toContain(t("previewUnavailable"));
    expect(document.querySelector('img[alt="portrait.webp"]')).toBeNull();
    const link = [...document.querySelectorAll("a")].find((element) => element.textContent === t("openOriginal"))!;
    expect(link.getAttribute("href")).toBe(current.url);
    expect(link.hasAttribute("download")).toBe(false);
    await render(media({ id: "landscape", filename: "landscape.webp", url: "https://media.example/landscape.webp" }));
    expect(document.body.textContent).not.toContain(t("previewUnavailable"));
    const next = document.querySelector<HTMLImageElement>('img[alt="landscape.webp"]')!;
    expect(next).not.toBe(first);
    await act(async () => next.dispatchEvent(new Event("load")));
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(next.classList.contains("invisible")).toBe(false);
  });

  it("keeps native video controls after metadata load and surfaces playback failures", async () => {
    await render(video());
    const player = document.querySelector("video")!;
    expect(player.controls).toBe(true);
    await act(async () => player.dispatchEvent(new Event("loadedmetadata")));
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => player.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="status"]')?.textContent).toContain(t("previewUnavailable"));
    expect(document.querySelector("video")).toBeNull();
  });

  it("does not retain another file's discard action when the owner replaces the file", async () => {
    await render();
    await type("media-description", "Draft for first file");
    click(r("close"));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await render(media({ id: "second", filename: "second.webp" }));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect((document.getElementById("media-filename") as HTMLInputElement).value).toBe("second.webp");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
