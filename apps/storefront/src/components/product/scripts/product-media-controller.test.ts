// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { storefrontSourcePath } from "@/lib/test-source-paths";
import {
  initProductMediaGallery,
  type ProductMediaChangeDetail,
} from "./product-media-controller";

const GALLERY_SOURCE = storefrontSourcePath(
  "components/product/ProductGallery.astro",
);
const PRODUCT_PAGE_SOURCE = storefrontSourcePath("pages/products/[slug].astro");
const API_TYPES_SOURCE = storefrontSourcePath("lib/api/types.ts");
const PRODUCT_CONTROLLER_SOURCE = storefrontSourcePath(
  "components/product/scripts/product-controller.ts",
);
const PRODUCT_ZOOM_SOURCE = storefrontSourcePath(
  "components/product/ProductImageZoom.tsx",
);
const GLOBAL_STYLE_SOURCE = storefrontSourcePath("styles/global.css");

function thumbnail(
  id: string,
  mediaId: string,
  kind: "image" | "video",
  url: string,
  options: { poster?: string; zoom?: string; preview?: string } = {},
): string {
  return `<button
    data-gallery-thumbnail
    data-product-media-id="${id}"
    data-media-id="${mediaId}"
    data-media-kind="${kind}"
    data-media-url="${url}"
    ${options.preview ? `data-preview-url="${options.preview}"` : ""}
    ${options.poster ? `data-poster-url="${options.poster}"` : ""}
    ${options.zoom ? `data-zoom-url="${options.zoom}"` : ""}
    data-alt-text="${kind === "video" ? "Demonstration" : "Front view"}"
  ><span data-thumb-ring></span></button>`;
}

function renderGallery(initial = "pmed_video") {
  const buttons = [
    thumbnail("pmed_video", "med_video", "video", "/demo.mp4", {
      poster: "/poster.jpg",
    }),
    thumbnail("pmed_image", "med_image", "image", "/image-main.jpg", {
      zoom: "/image-zoom.jpg",
      preview: "/image-preview.jpg",
    }),
  ].join("");
  document.body.innerHTML = `
    <div
      data-product-gallery
      data-initial-product-media-id="${initial}"
      data-fallback-url="/fallback-main.jpg"
      data-fallback-zoom-url="/fallback-zoom.jpg"
      data-fallback-media-id="med_poster"
      data-fallback-alt="Fallback image"
    >
      <div data-image-stage="desktop" class="hidden lg:block">
        <img data-desktop-main-image src="/fallback-main.jpg" />
      </div>
      <button data-image-stage="mobile" data-mobile-image-trigger>
        <img data-mobile-main-image src="/fallback-main.jpg" />
      </button>
      <div data-video-stage class="hidden">
        <div data-video-placeholder></div>
        <media-theme-microvideo data-product-video-player>
          <video data-product-video controls slot="media"></video>
        </media-theme-microvideo>
      </div>
      <div data-thumbnail-rail="desktop">${buttons}</div>
      <div data-thumbnail-rail="mobile">${buttons}</div>
    </div>
  `;
  return document.querySelector<HTMLElement>("[data-product-gallery]")!;
}

beforeEach(() => {
  document.body.innerHTML = "";
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mixed product media gallery", () => {
  it("selects a featured video without autoplay or eager offscreen video sources", () => {
    const root = renderGallery();
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener(
      "product-media-change",
      (event) => changes.push(event.detail),
      {
        once: true,
      },
    );

    initProductMediaGallery(root);

    const video = root.querySelector<HTMLVideoElement>("[data-product-video]")!;
    expect(video.src).toContain("/demo.mp4");
    expect(video.preload).toBe("metadata");
    expect(video.autoplay).toBe(false);
    expect(
      root
        .querySelector<HTMLElement>("[data-video-stage]")
        ?.classList.contains("hidden"),
    ).toBe(false);
    expect(changes[0]).toMatchObject({
      kind: "video",
      productMediaId: "pmed_video",
      mediaId: "med_video",
      posterUrl: "/poster.jpg",
      zoomUrl: null,
      source: "initial",
    });
  });

  it("switches between video and image while keeping zoom image-only", () => {
    const root = renderGallery();
    initProductMediaGallery(root);
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener("product-media-change", (event) =>
      changes.push(event.detail),
    );

    root
      .querySelectorAll<HTMLButtonElement>(
        "[data-product-media-id='pmed_image']",
      )[0]!
      .click();

    const video = root.querySelector<HTMLVideoElement>("[data-product-video]")!;
    const mobileImage = root.querySelector<HTMLImageElement>(
      "[data-mobile-main-image]",
    )!;
    const desktopMainImage = root.querySelector<HTMLImageElement>(
      "[data-desktop-main-image]",
    )!;
    expect(video.getAttribute("src")).toBeNull();
    expect(
      root
        .querySelector<HTMLElement>("[data-video-stage]")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(mobileImage.src).toContain("/image-preview.jpg");
    expect(desktopMainImage.src).toContain("/image-preview.jpg");
    expect(root.dataset.activeMediaUrl).toBe("/image-main.jpg");
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: "pmed_image",
      mediaId: "med_image",
      previewUrl: "/image-preview.jpg",
      zoomUrl: "/image-zoom.jpg",
      source: "gallery",
    });
  });

  it("shows the loaded preview immediately and promotes the decoded display image", async () => {
    const requests: Array<{
      src: string;
      fetchPriority: string;
      onload: (() => void) | null;
    }> = [];
    class DeferredImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      fetchPriority = "auto";
      decode = vi.fn().mockResolvedValue(undefined);
      private value = "";
      set src(value: string) {
        this.value = value;
        requests.push(this);
      }
      get src() {
        return this.value;
      }
    }
    vi.stubGlobal("Image", DeferredImage);

    const root = renderGallery();
    initProductMediaGallery(root);
    const imageButton = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="desktop"] [data-product-media-id="pmed_image"]',
    )!;
    imageButton.dataset.mediaUrl = "/promotion-full.jpg";
    imageButton.dataset.previewUrl = "/promotion-preview.jpg";
    imageButton.click();

    const main = root.querySelector<HTMLImageElement>(
      "[data-desktop-main-image]",
    )!;
    expect(main.src).toContain("/promotion-preview.jpg");
    expect(requests[0]).toMatchObject({
      src: "/promotion-full.jpg",
      fetchPriority: "high",
    });

    requests[0]!.onload?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(main.src).toContain("/promotion-full.jpg");
    expect(root.dataset.activeMediaDisplayUrl).toBe("/promotion-full.jpg");
  });

  it("does not let a slower previous image replace the shopper's latest selection", async () => {
    const requests: Array<{
      src: string;
      onload: (() => void) | null;
    }> = [];
    class DeferredImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      fetchPriority = "auto";
      decode = vi.fn().mockResolvedValue(undefined);
      private value = "";
      set src(value: string) {
        this.value = value;
        requests.push(this);
      }
      get src() {
        return this.value;
      }
    }
    vi.stubGlobal("Image", DeferredImage);

    const root = renderGallery();
    initProductMediaGallery(root);
    const imageButton = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="desktop"] [data-product-media-id="pmed_image"]',
    )!;
    const main = root.querySelector<HTMLImageElement>(
      "[data-desktop-main-image]",
    )!;

    imageButton.dataset.productMediaId = "pmed_first";
    imageButton.dataset.mediaUrl = "/first-full.jpg";
    imageButton.dataset.previewUrl = "/first-preview.jpg";
    imageButton.click();

    imageButton.dataset.productMediaId = "pmed_latest";
    imageButton.dataset.mediaUrl = "/latest-full.jpg";
    imageButton.dataset.previewUrl = "/latest-preview.jpg";
    imageButton.click();
    expect(main.src).toContain("/latest-preview.jpg");

    requests[0]!.onload?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(main.src).toContain("/latest-preview.jpg");

    requests[1]!.onload?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(main.src).toContain("/latest-full.jpg");
  });

  it("uses exact SKU images and an image representation for unmapped SKUs", () => {
    const root = renderGallery();
    initProductMediaGallery(root);
    const changes: ProductMediaChangeDetail[] = [];
    window.addEventListener("product-media-change", (event) =>
      changes.push(event.detail),
    );
    const desktopImage = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="desktop"] [data-product-media-id="pmed_image"]',
    )!;
    const mobileImage = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="mobile"] [data-product-media-id="pmed_image"]',
    )!;
    desktopImage.scrollIntoView = vi.fn();
    mobileImage.scrollIntoView = vi.fn();

    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: "pmed_image", source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: "pmed_image",
      source: "variant",
    });
    expect(mobileImage.scrollIntoView).toHaveBeenCalledOnce();
    expect(mobileImage.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
    });
    expect(desktopImage.scrollIntoView).not.toHaveBeenCalled();

    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: null, source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: null,
      mediaId: "med_poster",
      url: "/fallback-main.jpg",
      source: "variant",
    });
    expect(
      root.querySelector<HTMLVideoElement>("[data-product-video]")?.autoplay,
    ).toBe(false);

    // Even a corrupt legacy video association cannot enter the SKU image path.
    window.dispatchEvent(
      new CustomEvent("product-media-select", {
        detail: { productMediaId: "pmed_video", source: "variant" },
      }),
    );
    expect(changes.at(-1)).toMatchObject({
      kind: "image",
      productMediaId: null,
      url: "/fallback-main.jpg",
      source: "variant",
    });
  });

  it("supports roving keyboard focus and replaces listeners on reinitialization", () => {
    const root = renderGallery("pmed_image");
    initProductMediaGallery(root);
    initProductMediaGallery(root);
    const changes = vi.fn();
    window.addEventListener("product-media-change", changes);
    const active = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="desktop"] [data-product-media-id="pmed_image"]',
    )!;

    active.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );

    const video = root.querySelector<HTMLButtonElement>(
      '[data-thumbnail-rail="desktop"] [data-product-media-id="pmed_video"]',
    )!;
    expect(document.activeElement).toBe(video);
    expect(video.getAttribute("aria-current")).toBe("true");
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe("storefront mixed-media source boundaries", () => {
  it("keeps video out of image optimizer and zoom paths", () => {
    const source = readFileSync(GALLERY_SOURCE, "utf8");
    expect(source).toContain('item.kind === "video"');
    expect(source).toContain("data-product-video");
    expect(source).toContain("media-theme-microvideo");
    expect(source).toContain('slot="media"');
    expect(source).toContain("controls");
    expect(source).toContain("playsinline");
    expect(source).toMatch(
      /preload=\{initialMedia\?\.item\.kind === "video"\s*\? "metadata"\s*: "none"\}/,
    );
    expect(source).toMatch(
      /src=\{initialMedia\?\.item\.kind === "video"\s*\? initialMedia\.mainUrl\s*: undefined\}/,
    );
    expect(source).toMatch(
      /poster=\{initialMedia\?\.item\.kind === "video"\s*\? \(initialMedia\.posterUrl \?\? undefined\)\s*: undefined\}/,
    );
    expect(source).toContain("item.posterUrl");
    expect(source).toContain("absolute inset-0 z-0");
    expect(source).toContain("relative z-10 block h-full w-full");
    expect(source).not.toContain("absolute inset-0 z-20 flex flex-col");
    expect(source).not.toContain("<source");
    expect(source).not.toContain("product-image-change");

    const controller = readFileSync(
      storefrontSourcePath(
        "components/product/scripts/product-media-controller.ts",
      ),
      "utf8",
    );
    expect(controller).toContain('import("@player.style/microvideo")');
    expect(controller).toContain('customElements.whenDefined("media-theme-microvideo")');
    expect(controller).toContain("video.controls = false");
    expect(controller).toContain("video.controls = true");
    const styles = readFileSync(GLOBAL_STYLE_SOURCE, "utf8");
    expect(styles).toContain("media-theme-microvideo::part(button)");
    expect(styles).toContain("min-width: 44px");
  });

  it("passes the ordered media contract directly and removes the image adapter type", () => {
    const page = readFileSync(PRODUCT_PAGE_SOURCE, "utf8");
    const types = readFileSync(API_TYPES_SOURCE, "utf8");
    const controller = readFileSync(PRODUCT_CONTROLLER_SOURCE, "utf8");
    expect(page).toContain("media={media}");
    expect(page).not.toContain("const images = media.flatMap");
    expect(types).not.toContain("interface ProductImage");
    expect(controller).toContain('new CustomEvent("product-media-select"');
    expect(controller).toContain("resolveVariantImageForSelection(");
    expect(controller).toContain("resolveVariantCartMedia(validation.variant");
    expect(controller).toContain("imageMediaId: cache.container.dataset.productImageMediaId");
    expect(controller).not.toContain("currentDisplayedImage");
    expect(controller).not.toContain("product-image-change");
    expect(controller).not.toContain("controller-image-update");
  });

  it("uses one reusable preview transform and defers full and zoom work until intent", () => {
    const gallery = readFileSync(GALLERY_SOURCE, "utf8");
    const controller = readFileSync(
      storefrontSourcePath(
        "components/product/scripts/product-media-controller.ts",
      ),
      "utf8",
    );
    const zoom = readFileSync(PRODUCT_ZOOM_SOURCE, "utf8");
    expect(gallery).toContain("data-variant-image");
    expect(gallery).toContain("variantImageIds.has(itemData.item.id)");
    expect(gallery).toContain("data-preview-url");
    expect(gallery).toContain("imageTransforms.preview");
    expect(controller).toContain('preloadImage(item.url, "high")');
    expect(controller).toContain("activeMediaDisplayUrl");
    expect(controller).toContain("imagePreloads");
    expect(controller).not.toContain("scheduleInitialImagePreload");
    expect(zoom).not.toContain("scheduleZoomImagePreload");
    expect(zoom).toContain("requestZoomImage");
    expect(zoom).toContain("imagePreloads");
  });
});
