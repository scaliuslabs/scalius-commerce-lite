// @vitest-environment happy-dom

import { act, cloneElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import type { LibraryMediaFile, MediaFile } from "../types";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { MergeChoiceHost } from "~/components/admin/realtime/MergeChoiceDialog";
import { realtimeMergeMessages } from "~/i18n/realtime-merge";
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
const onReload = vi.fn<ComponentProps<typeof MediaPreview>["onReload"]>();
const onAdopt = vi.fn();
let host: HTMLDivElement;
let root: Root;
let current: LibraryMediaFile;
let well = { width: 712, height: 452 };

beforeEach(() => {
  vi.resetAllMocks();
  setLocale("en");
  well = { width: 712, height: 452 };
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // Happy DOM has no layout. Only the image well receives a measured box.
    return this.matches(".relative.size-full") ? DOMRect.fromRect(well) : bounds.call(this);
  });
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
  vi.restoreAllMocks();
});

async function render(file = current, picker = false, canEdit = true) {
  current = file;
  await act(async () => root.render(<><MediaPreview canEdit={canEdit} onReload={onReload} onAdopt={onAdopt} open file={file} files={[media({ id: "previous" }), file, media({ id: "next" })]}
    onOpenChange={onOpenChange} onNavigate={onNavigate} onUpdate={onUpdate} onSelect={picker ? onSelect : undefined} /><MergeChoiceHost /></>));
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
  it("loads a fresh version and preserves local changes without automatically retrying", async () => {
    onUpdate.mockRejectedValueOnce(new AdminApiResponseError("Changed", 409, "CONFLICT"));
    const fresh = media({ filename: "server-renamed.webp", version: 2 });
    onReload.mockResolvedValue(fresh);
    await render();
    await type("media-description", "My alt text");
    await act(async () => save().click());
    expect(onReload).toHaveBeenCalledExactlyOnceWith(current.id);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledExactlyOnceWith(fresh));
    await render(fresh);
    expect((document.getElementById("media-filename") as HTMLInputElement).value).toBe("server-renamed.webp");
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("My alt text");
    expect(document.body.textContent).toContain(t("metadataReloaded"));
    onUpdate.mockResolvedValue({ ...fresh, altText: "My alt text", version: 3 });
    await act(async () => save().click());
    expect(onUpdate.mock.calls[1]).toEqual([fresh, { filename: "server-renamed.webp", altText: "My alt text" }]);
    expect(save().disabled).toBe(true);
  });

  it("requires a choice for overlapping edits and keeps the old base when cancelled", async () => {
    onUpdate.mockRejectedValue(new AdminApiResponseError("Changed", 409, "CONFLICT"));
    onReload.mockResolvedValue(media({ altText: "Their alt text", version: 2 }));
    await render();
    await type("media-description", "My alt text");
    await act(async () => { save().click(); });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Their alt text"));
    expect(onAdopt).not.toHaveBeenCalled();
    expect(button(t("nextFile")).disabled).toBe(true);
    await act(async () => button(translate(realtimeMergeMessages, "mergeCancel")).click());
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("My alt text");
    expect(onAdopt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(save().disabled).toBe(false));
    await act(async () => { save().click(); });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Their alt text"));
    expect(onUpdate.mock.calls[1]?.[0].version).toBe(1);
    await act(async () => button(translate(realtimeMergeMessages, "mergeCancel")).click());
  });

  it("retains copyable edits when the file was removed, and never reloads dependency conflicts", async () => {
    onUpdate.mockRejectedValueOnce(new AdminApiResponseError("Changed", 409, "MEDIA_DEPENDENCY_CONFLICT"));
    await render();
    await type("media-description", "Keep this text");
    await act(async () => save().click());
    expect(onReload).not.toHaveBeenCalled();
    onUpdate.mockRejectedValueOnce(new AdminApiResponseError("Changed", 409, "CONFLICT"));
    onReload.mockResolvedValue(null);
    await act(async () => save().click());
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain(t("metadataUnavailable"));
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Keep this text");
  });

  it("lets viewers inspect and select without offering metadata mutations", async () => {
    await render(video(), true, false);
    expect((document.getElementById("media-filename") as HTMLInputElement).readOnly).toBe(true);
    expect((document.getElementById("media-description") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(save()).toBeUndefined();
    expect(button(t("chooseCoverImage"))).toBeUndefined();
    click(t("useVideo"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("shows saved metadata and cover after edit permission is revoked", async () => {
    const saved = video({ caption: "Saved caption", posterMediaId: "saved_cover", posterUrl: "https://media.example/saved-cover.webp" });
    await render(saved);
    await type("media-filename", "Unsaved name.mp4");
    await type("media-description", "Unsaved caption");
    click(t("changeCoverImage"));
    expect(document.querySelector("video")?.getAttribute("poster")).toContain("/cover.webp");
    click(t("nextFile"));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await render(saved, false, false);
    expect((document.getElementById("media-filename") as HTMLInputElement).value).toBe(saved.filename);
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Saved caption");
    expect(document.querySelector("video")?.getAttribute("poster")).toContain("/saved-cover.webp");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(save()).toBeUndefined();
    expect(onUpdate).not.toHaveBeenCalled();
  });

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
    expect(document.querySelector("video")?.getAttribute("poster")).toContain("/cover.webp");
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
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
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
    expect([...document.querySelectorAll('[role="status"]')].some((element) => element.textContent?.trim())).toBe(false);
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


describe("media image inspection", () => {
  const region = () => document.querySelector<HTMLDivElement>(`[role="region"][aria-label="${t("originalSizeHint")}"]`);
  const originalImage = () => region()!.querySelector("img")!;
  const rendition = (overrides: Partial<LibraryMediaFile> = {}) => media({
    url: "https://media.example/media/portrait.jpg/1600.webp", width: 1600, height: 3200, ...overrides,
  });
  const load = (image: HTMLImageElement) => act(async () => image.dispatchEvent(new Event("load")));
  async function readyOriginal() {
    Object.defineProperty(originalImage(), "decode", { value: vi.fn().mockResolvedValue(undefined), configurable: true });
    await load(originalImage());
  }

  it("sizes published renditions to the contained portrait, landscape and short viewport", async () => {
    await render(rendition());
    let image = document.querySelector("img")!;
    expect(image.sizes).toBe("226px");
    expect(image.srcset).toContain("/511.webp 511w");
    expect(image.srcset).not.toContain("/2400.webp");
    await render(rendition({ id: "landscape", width: 1600, height: 800 }));
    image = document.querySelector("img")!;
    expect(image.sizes).toBe("712px");
    well.height = 180;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(image.sizes).toBe("360px");
  });

  it("caps a small rendition at its saved width and publishes only real ladder widths", async () => {
    await render(rendition({ url: "https://media.example/media/logo.png/350.webp", width: 350, height: 98 }));
    const image = document.querySelector("img")!;
    expect(image.sizes).toBe("350px");
    expect(image.style.getPropertyValue("--media-original-width")).toBe("350px");
    expect(image.srcset.split(", ").map((part) => part.split(" ")[1])).toEqual(["144w", "172w", "206w", "247w", "296w", "350w"]);
    well.width = 200;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(image.sizes).toBe("200px");
    expect(image.srcset).not.toContain("/355.webp");
    expect(region()).toBeNull();
  });

  it("keeps the single-source fallback when dimensions are unavailable and leaves videos native", async () => {
    await render(rendition({ width: null, height: null }));
    expect(document.querySelector("img")!.getAttribute("srcset")).toBeNull();
    expect(document.querySelector("img")!.src).toContain("/960.webp");
    await render(video());
    expect(button(t("originalSize"))).toBeUndefined();
    expect(document.querySelector("video")!.controls).toBe(true);
  });

  it.each(["en", "bn"] as const)("loads the original on demand without replacing Fit or the draft in %s", async (locale) => {
    setLocale(locale);
    await render(rendition());
    const fitted = document.querySelector("img")!;
    await load(fitted);
    await type("media-description", "Unsaved detail");
    expect(region()).toBeNull();
    await act(async () => button(t("originalSize")).focus());
    click(t("originalSize"));
    expect(originalImage().src).toBe("https://media.example/media/portrait.jpg");
    expect(originalImage().getAttribute("srcset")).toBeNull();
    expect(originalImage().classList.contains("max-w-none")).toBe(true);
    expect(button(t("fitPreview")).getAttribute("aria-busy")).toBe("true");
    let finish!: () => void;
    Object.defineProperty(originalImage(), "decode", { value: () => new Promise<void>((resolve) => { finish = resolve; }) });
    await load(originalImage());
    expect(region()!.getAttribute("aria-hidden")).toBe("true");
    expect(fitted.parentElement!.classList.contains("invisible")).toBe(false);
    await act(async () => finish());
    expect(region()!.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(region());
    expect(document.querySelector("img")).toBe(fitted);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(region()!.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(button(t("originalSize")));
    expect((document.getElementById("media-description") as HTMLTextAreaElement).value).toBe("Unsaved detail");
    expect(save().disabled).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps Fit after original failure, retries, and does not steal a metadata field's focus", async () => {
    await render(rendition());
    const fitted = document.querySelector("img")!;
    await load(fitted);
    click(t("originalSize"));
    Object.defineProperty(originalImage(), "decode", { value: vi.fn().mockRejectedValue(new Error("decode refused")) });
    await load(originalImage());
    expect(document.body.textContent).toContain(t("originalPreviewFailed"));
    expect(region()).toBeNull();
    expect(document.querySelector("img")).toBe(fitted);
    expect(fitted.classList.contains("invisible")).toBe(false);
    click(t("originalSize"));
    const field = document.getElementById("media-description")!;
    await act(async () => field.focus());
    await readyOriginal();
    expect(document.activeElement).toBe(field);
    expect(document.body.textContent).not.toContain(t("originalPreviewFailed"));
    expect(region()!.hasAttribute("aria-hidden")).toBe(false);
  });

  it("resets inspection on navigation and ignores a detached original's late decode", async () => {
    const first = rendition();
    await render(first);
    click(t("originalSize"));
    let finish!: () => void;
    Object.defineProperty(originalImage(), "decode", { value: () => new Promise<void>((resolve) => { finish = resolve; }) });
    await load(originalImage());
    await render(rendition({ id: "other", url: "https://media.example/media/other.jpg/1600.webp" }));
    expect(region()).toBeNull();
    await render(first);
    await act(async () => finish());
    expect(region()).toBeNull();
    expect(button(t("originalSize"))).toBeDefined();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
