// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindDesktopZoomWhenEligible,
  initProductMediaGallery,
  PRELOAD_CONCURRENCY,
  SWITCH_DECODE_TIMEOUT_MS,
  type ProductMediaChangeDetail,
} from "./product-media-controller";
import { bindDesktopZoom } from "./product-desktop-zoom-controller";

const SIZES = "(max-width: 1023px) 384px, 468px";
const LADDER = [144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1600];

/** A published media URL (its 1600 master rendition). */
function media(name: string): string {
  return `https://cdn.test/media/${name}.jpg/1600.webp`;
}
function rendition(name: string, width: number): string {
  return `https://cdn.test/media/${name}.jpg/${width}.webp`;
}
function srcset(name: string): string {
  return LADDER.map((width) => `${rendition(name, width)} ${width}w`).join(
    ", ",
  );
}
const LEGACY = "https://cdn.test/media/legacy.jpg";

/**
 * A detached `new Image()`: records what the controller asked the browser
 * to fetch; tests settle `decode()` / `onload` by hand.
 */
class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "";
  fetchPriority = "";
  sizes = "";
  srcset = "";
  src = "";
  private settle!: () => void;
  private decoded = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  decode = vi.fn(() => this.decoded);
  constructor() {
    FakeImage.created.push(this);
  }
  finishDecode() {
    this.settle();
  }
}

function thumbnail(
  id: string,
  mediaId: string,
  kind: "image" | "video",
  url: string,
  options: { poster?: string; alt?: string } = {},
): string {
  return `<button
    data-gallery-thumbnail
    data-product-media-id="${id}"
    data-media-id="${mediaId}"
    data-media-kind="${kind}"
    data-media-url="${url}"
    ${options.poster ? `data-poster-url="${options.poster}"` : ""}
    data-alt-text="${options.alt ?? (kind === "video" ? "Demonstration" : "Front view")}"
  ><span data-thumb-ring></span></button>`;
}

function renderGallery(
  initial = "pmed_video",
  options: { variants?: Array<{ imageId: string | null }> } = {},
) {
  const buttons = [
    thumbnail("pmed_video", "med_video", "video", "/demo.mp4", {
      poster: "/poster.jpg",
    }),
    thumbnail("pmed_front", "med_front", "image", media("front")),
    thumbnail("pmed_side", "med_side", "image", media("side"), {
      alt: "Side view",
    }),
    thumbnail("pmed_back", "med_back", "image", media("back"), {
      alt: "Back view",
    }),
    thumbnail("pmed_legacy", "med_legacy", "image", LEGACY, {
      alt: "Legacy photo",
    }),
  ].join("");
  document.body.innerHTML = `
    <header data-page-background></header>
    <main>
      ${
        options.variants
          ? `<script id="product-variants-data" type="application/json">${JSON.stringify(options.variants)}</script>`
          : ""
      }
      <div
        data-product-gallery
        data-initial-product-media-id="${initial}"
        data-main-sizes="${SIZES}"
        data-fallback-url="${media("primary")}"
        data-fallback-media-id="med_primary"
        data-fallback-alt="Fallback image"
      >
        <div data-image-stage="desktop" class="hidden lg:block">
          <div data-desktop-image-zoom>
            <img data-desktop-main-image src="/placeholder-product.svg" />
            <div data-desktop-zoom-layer></div>
          </div>
        </div>
        <button data-image-stage="mobile" data-mobile-image-trigger>
          <img data-mobile-main-image src="/placeholder-product.svg" />
        </button>
        <div data-video-stage class="hidden">
          <a data-video-facade data-gallery-video data-video-kind="file"
            data-video-src="/demo.mp4" data-video-title="Demonstration"
            data-label-template="Play video: {title}" href="/demo.mp4">
            <img data-video-poster />
            <span data-video-duration hidden></span>
          </a>
        </div>
        <div data-thumbnail-rail="desktop">${buttons}</div>
        <div data-thumbnail-rail="mobile">${buttons}</div>
        <div data-mobile-zoom-modal role="dialog" aria-hidden="true" inert>
          <button data-close-mobile-zoom tabindex="-1">Close</button>
          <div data-panzoom-container>
            <img data-fullscreen-image />
          </div>
        </div>
      </div>
      <aside data-page-background></aside>
    </main>
    <footer data-page-background></footer>
  `;
  return document.querySelector<HTMLElement>("[data-product-gallery]")!;
}

/** Render the main images exactly as SSR does for `name`. */
function renderSsrImage(root: HTMLElement, name: string, alt = "Front view") {
  for (const image of mainImages(root)) {
    image.setAttribute("src", rendition(name, 960));
    image.setAttribute("srcset", srcset(name));
    image.setAttribute("sizes", SIZES);
    image.alt = alt;
  }
}

function mainImages(root: HTMLElement): HTMLImageElement[] {
  return [
    root.querySelector<HTMLImageElement>("[data-mobile-main-image]")!,
    root.querySelector<HTMLImageElement>("[data-desktop-main-image]")!,
  ];
}

function button(root: HTMLElement, id: string, rail = "desktop") {
  return root.querySelector<HTMLButtonElement>(
    `[data-thumbnail-rail="${rail}"] [data-product-media-id="${id}"]`,
  )!;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

let idleTasks: Array<() => void> = [];

beforeEach(() => {
  FakeImage.created = [];
  idleTasks = [];
  vi.stubGlobal("Image", FakeImage);
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    writable: true,
    value: (task: () => void) => {
      idleTasks.push(task);
      return idleTasks.length;
    },
  });
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
  vi.spyOn(
    RemotePlayback.prototype,
    "cancelWatchAvailability",
  ).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("product gallery photo switching", () => {
  it("adopts the SSR photo without rewriting it before LCP", () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener("product-media-change", (event) =>
      changes.push(event.detail),
    );

    initProductMediaGallery(root);

    expect(changes).toHaveLength(0);
    expect(FakeImage.created).toHaveLength(0);
    expect(root.dataset.activeMediaKey).toBe("image:pmed_front");
    expect(root.dataset.activeMediaZoomUrl).toBe(rendition("front", 1600));
    for (const image of mainImages(root)) {
      expect(image.getAttribute("srcset")).toBe(srcset("front"));
    }
  });

  it("swaps src, srcset, sizes and alt on both main images once the new photo decodes", async () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener("product-media-change", (event) =>
      changes.push(event.detail),
    );

    button(root, "pmed_side").click();

    // The thumbnail and the change event answer the click at once...
    expect(button(root, "pmed_side").getAttribute("aria-current")).toBe("true");
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: "pmed_side",
      url: media("side"),
      zoomUrl: rendition("side", 1600),
      source: "gallery",
    });
    // ...while the visible photo waits for a decoded candidate, requested
    // with the slot's own srcset/sizes so the browser picks the same file.
    const candidate = FakeImage.created.at(-1)!;
    expect(candidate).toMatchObject({
      src: rendition("side", 960),
      srcset: srcset("side"),
      sizes: SIZES,
      fetchPriority: "high",
    });
    expect(candidate.decode).toHaveBeenCalledOnce();
    for (const image of mainImages(root)) {
      expect(image.getAttribute("src")).toBe(rendition("front", 960));
    }

    candidate.finishDecode();
    await flush();

    for (const image of mainImages(root)) {
      expect(image.getAttribute("src")).toBe(rendition("side", 960));
      expect(image.getAttribute("srcset")).toBe(srcset("side"));
      expect(image.getAttribute("sizes")).toBe(SIZES);
      expect(image.alt).toBe("Side view");
    }
  });

  it("serves photos without renditions as a plain src", async () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);

    button(root, "pmed_legacy").click();
    const candidate = FakeImage.created.at(-1)!;
    expect(candidate.src).toBe(LEGACY);
    expect(candidate.srcset).toBe("");
    candidate.finishDecode();
    await flush();

    for (const image of mainImages(root)) {
      expect(image.getAttribute("src")).toBe(LEGACY);
      expect(image.hasAttribute("srcset")).toBe(false);
      expect(image.hasAttribute("sizes")).toBe(false);
      expect(image.alt).toBe("Legacy photo");
    }
    expect(root.dataset.activeMediaZoomUrl).toBe(LEGACY);
  });

  it("shows the new photo anyway when decoding outlasts the timeout", async () => {
    vi.useFakeTimers();
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);

    button(root, "pmed_back").click();
    await vi.advanceTimersByTimeAsync(SWITCH_DECODE_TIMEOUT_MS - 1);
    expect(mainImages(root)[0]!.getAttribute("src")).toBe(
      rendition("front", 960),
    );

    await vi.advanceTimersByTimeAsync(1);
    for (const image of mainImages(root)) {
      expect(image.getAttribute("src")).toBe(rendition("back", 960));
      expect(image.getAttribute("srcset")).toBe(srcset("back"));
    }
  });

  it("keeps the shopper's latest selection authoritative", async () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);

    button(root, "pmed_side").click();
    const side = FakeImage.created.at(-1)!;
    button(root, "pmed_back").click();
    const back = FakeImage.created.at(-1)!;

    back.finishDecode();
    await flush();
    side.finishDecode();
    await flush();

    for (const image of mainImages(root)) {
      expect(image.getAttribute("src")).toBe(rendition("back", 960));
      expect(image.alt).toBe("Back view");
    }
  });

  it("uses exact SKU photos and the product photo for SKUs without one", async () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener("product-media-change", (event) =>
      changes.push(event.detail),
    );
    const mobileSide = button(root, "pmed_side", "mobile");
    const desktopSide = button(root, "pmed_side", "desktop");
    mobileSide.scrollIntoView = vi.fn();
    desktopSide.scrollIntoView = vi.fn();

    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: "pmed_side", source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      productMediaId: "pmed_side",
      source: "variant",
    });
    expect(mobileSide.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
    });
    expect(desktopSide.scrollIntoView).not.toHaveBeenCalled();
    FakeImage.created.at(-1)!.finishDecode();
    await flush();
    expect(mainImages(root)[1]!.getAttribute("srcset")).toBe(srcset("side"));

    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: null, source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: null,
      mediaId: "med_primary",
      url: media("primary"),
      source: "variant",
    });
    FakeImage.created.at(-1)!.finishDecode();
    await flush();
    for (const image of mainImages(root)) {
      expect(image.getAttribute("srcset")).toBe(srcset("primary"));
      expect(image.alt).toBe("Fallback image");
    }

    // Even a corrupt legacy video association cannot enter the SKU image path.
    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: "pmed_video", source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: null,
      url: media("primary"),
    });
  });

  it("shows a featured video as its poster, with no player and no video bytes until play", () => {
    const root = renderGallery();
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener(
      "product-media-change",
      (event) => changes.push(event.detail),
      { once: true },
    );

    initProductMediaGallery(root);

    const stage = root.querySelector<HTMLElement>("[data-video-stage]")!;
    expect(stage.classList.contains("hidden")).toBe(false);
    expect(root.querySelector("video")).toBeNull();
    expect(root.querySelector<HTMLImageElement>("[data-video-poster]")!.getAttribute("src")).toBe("/poster.jpg");
    expect(changes[0]).toMatchObject({
      kind: "video",
      productMediaId: "pmed_video",
      posterUrl: "/poster.jpg",
      zoomUrl: null,
      source: "initial",
    });
  });

  it("mounts the player in the same box on press and removes it on a photo", async () => {
    const root = renderGallery();
    initProductMediaGallery(root);
    const stage = root.querySelector<HTMLElement>("[data-video-stage]")!;
    const facade = stage.querySelector<HTMLElement>("[data-video-facade]")!;
    const mobileStage = root.querySelector<HTMLElement>(
      "[data-image-stage='mobile']",
    )!;

    facade.click();
    const video = stage.querySelector<HTMLVideoElement>("video[data-video-player]")!;
    expect(video.getAttribute("src")).toBe("/demo.mp4");
    expect(video.controls).toBe(true);
    expect(facade.hidden).toBe(true);

    button(root, "pmed_front").click();
    expect(stage.classList.contains("hidden")).toBe(false);
    FakeImage.created.at(-1)!.finishDecode();
    await flush();
    expect(stage.classList.contains("hidden")).toBe(true);
    expect(stage.querySelector("video")).toBeNull();
    expect(facade.hidden).toBe(false);
    expect(mobileStage.classList.contains("hidden")).toBe(false);
    expect(mainImages(root)[0]!.getAttribute("srcset")).toBe(srcset("front"));

    // Switching to the video is immediate and cancels any pending photo.
    button(root, "pmed_side").click();
    button(root, "pmed_video").click();
    FakeImage.created.at(-1)!.finishDecode();
    await flush();
    expect(stage.classList.contains("hidden")).toBe(false);
    expect(facade.getAttribute("aria-label")).toBe("Play video: Demonstration");
    expect(mainImages(root)[0]!.getAttribute("srcset")).toBe(srcset("front"));
  });

  it("supports roving keyboard focus and replaces listeners on reinitialization", () => {
    const root = renderGallery("pmed_front");
    initProductMediaGallery(root);
    initProductMediaGallery(root);
    const changes = vi.fn();
    window.addEventListener("product-media-change", changes);

    button(root, "pmed_front").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );

    const video = button(root, "pmed_video");
    expect(document.activeElement).toBe(video);
    expect(video.getAttribute("aria-current")).toBe("true");
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe("product gallery preloading", () => {
  it("warms SKU photos first after load, in the slot's candidate, two at a time", async () => {
    const root = renderGallery("pmed_front", {
      variants: [{ imageId: "pmed_back" }, { imageId: "pmed_back" }],
    });
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    expect(FakeImage.created).toHaveLength(0);

    idleTasks.forEach((task) => task());
    expect(FakeImage.created).toHaveLength(PRELOAD_CONCURRENCY);
    expect(FakeImage.created.map((image) => image.src)).toEqual([
      rendition("back", 960),
      rendition("side", 960),
    ]);
    expect(FakeImage.created[0]).toMatchObject({
      srcset: srcset("back"),
      sizes: SIZES,
      fetchPriority: "low",
    });
    // Preloads fetch only; decoding waits for an actual switch.
    expect(FakeImage.created[0]!.decode).not.toHaveBeenCalled();

    FakeImage.created[0]!.onload?.();
    await flush();
    expect(FakeImage.created).toHaveLength(3);
    expect(FakeImage.created[2]!.src).toBe(LEGACY);

    FakeImage.created[1]!.onload?.();
    FakeImage.created[2]!.onerror?.();
    await flush();
    // The active photo and the video are never preloaded.
    expect(FakeImage.created).toHaveLength(3);
  });

  it("warms the product photo for SKUs without their own photo", () => {
    const root = renderGallery("pmed_front", {
      variants: [{ imageId: null }],
    });
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    idleTasks.forEach((task) => task());
    expect(FakeImage.created[0]!.src).toBe(rendition("primary", 960));
  });

  it("does not preload on Save-Data and preloads less on 3G", async () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    let root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    idleTasks.forEach((task) => task());
    expect(FakeImage.created).toHaveLength(0);

    vi.stubGlobal("navigator", { connection: { effectiveType: "3g" } });
    idleTasks = [];
    root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    idleTasks.forEach((task) => task());
    for (let round = 0; round < 5; round += 1) {
      FakeImage.created.forEach((image) => image.onload?.());
      await flush();
    }
    expect(FakeImage.created).toHaveLength(3);
  });

  it("fetches a thumbnail's photo at high priority on focus, once", () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);

    const thumb = button(root, "pmed_side", "mobile");
    thumb.dispatchEvent(new FocusEvent("focus"));
    thumb.dispatchEvent(new FocusEvent("focus"));

    expect(FakeImage.created).toHaveLength(1);
    expect(FakeImage.created[0]).toMatchObject({
      src: rendition("side", 960),
      srcset: srcset("side"),
      fetchPriority: "high",
    });
  });
});

describe("product gallery zoom", () => {
  it("makes mobile zoom a real modal with the 1600 rendition and restores the page on close", () => {
    document.body.style.overflow = "clip";
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);

    const trigger = root.querySelector<HTMLButtonElement>(
      "[data-mobile-image-trigger]",
    )!;
    const modal = root.querySelector<HTMLElement>("[data-mobile-zoom-modal]")!;
    const close = root.querySelector<HTMLButtonElement>(
      "[data-close-mobile-zoom]",
    )!;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>("[data-page-background]"),
    );

    trigger.click();

    expect(
      root.querySelector<HTMLImageElement>("[data-fullscreen-image]")!.src,
    ).toBe(rendition("front", 1600));
    expect(modal.inert).toBe(false);
    expect(modal.getAttribute("aria-hidden")).toBe("false");
    expect(background.every((element) => element.inert)).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(document.body.style.overflow).toBe("hidden");

    close.click();

    expect(modal.inert).toBe(true);
    expect(modal.getAttribute("aria-hidden")).toBe("true");
    expect(background.every((element) => !element.inert)).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("clip");
  });

  it("loads desktop zoom detail only after hover and restores the base image", async () => {
    const root = renderGallery("pmed_front");
    renderSsrImage(root, "front");
    initProductMediaGallery(root);
    bindDesktopZoom(root, new AbortController().signal);
    const before = FakeImage.created.length;

    const zoom = root.querySelector<HTMLElement>("[data-desktop-image-zoom]")!;
    const layer = root.querySelector<HTMLElement>("[data-desktop-zoom-layer]")!;
    const image = mainImages(root)[1]!;
    zoom.dispatchEvent(new MouseEvent("mouseenter"));

    expect(FakeImage.created).toHaveLength(before + 1);
    expect(FakeImage.created.at(-1)).toMatchObject({
      src: rendition("front", 1600),
      fetchPriority: "high",
    });
    expect(image.classList.contains("opacity-0")).toBe(true);
    expect(layer.classList.contains("opacity-0")).toBe(false);

    FakeImage.created.at(-1)!.finishDecode();
    FakeImage.created.at(-1)!.onload?.();
    await flush();
    expect(layer.style.backgroundImage).toContain(rendition("front", 1600));

    zoom.dispatchEvent(new MouseEvent("mouseleave"));
    expect(image.classList.contains("opacity-0")).toBe(false);
    expect(layer.classList.contains("opacity-0")).toBe(true);
  });

  it("zooms into the photo on screen on Save-Data", () => {
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const root = renderGallery("pmed_back");
    renderSsrImage(root, "back");
    root.dataset.activeMediaKey = "image:pmed_back";
    root.dataset.activeMediaZoomUrl = rendition("back", 1600);
    bindDesktopZoom(root, new AbortController().signal);

    root
      .querySelector<HTMLElement>("[data-desktop-image-zoom]")!
      .dispatchEvent(new MouseEvent("mouseenter"));

    expect(FakeImage.created).toHaveLength(0);
    expect(
      root.querySelector<HTMLElement>("[data-desktop-zoom-layer]")!.style
        .backgroundImage,
    ).toContain(rendition("back", 960));
  });

  it("loads desktop zoom once when a resized viewport first crosses 1024px", async () => {
    const query = new EventTarget() as MediaQueryList;
    Object.defineProperty(query, "matches", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => query),
    });
    const bindDesktopZoomMock = vi.fn();
    const loadController = vi.fn(async () => ({
      bindDesktopZoom: bindDesktopZoomMock,
    }));
    const root = renderGallery("pmed_front");

    bindDesktopZoomWhenEligible(
      root,
      new AbortController().signal,
      loadController,
    );
    expect(loadController).not.toHaveBeenCalled();

    Object.defineProperty(query, "matches", {
      configurable: true,
      value: true,
    });
    query.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(bindDesktopZoomMock).toHaveBeenCalledOnce());
    query.dispatchEvent(new Event("change"));

    expect(loadController).toHaveBeenCalledOnce();
  });
});
