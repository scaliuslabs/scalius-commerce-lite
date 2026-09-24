import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  responsiveImageSources,
  type ResponsiveImageSources,
} from "@/lib/responsive-image";
import { GALLERY_IMAGE_WIDTHS } from "../lib/gallery-images";
import { loadVariantsFromDOM } from "../lib/variant-state-machine";

export type ProductMediaSelectionSource = "initial" | "gallery" | "variant";

export interface ProductMediaChangeDetail {
  kind: "image" | "video";
  productMediaId: string | null;
  mediaId: string | null;
  /** Image: the CDN URL every slot derives from. Video: the video file. */
  url: string;
  posterUrl: string | null;
  zoomUrl: string | null;
  altText: string;
  source: ProductMediaSelectionSource;
}

export interface ProductMediaSelectDetail {
  productMediaId: string | null;
  source: "variant";
}

declare global {
  interface WindowEventMap {
    "product-media-change": CustomEvent<ProductMediaChangeDetail>;
    "product-media-select": CustomEvent<ProductMediaSelectDetail>;
  }
}

interface GalleryItem extends Omit<ProductMediaChangeDetail, "zoomUrl"> {
  thumbnail: HTMLButtonElement | null;
}

/** Longest a switch keeps the current photo while the next one decodes. */
export const SWITCH_DECODE_TIMEOUT_MS = 500;
/** Idle warm-up of the other gallery photos: parallel requests. */
export const PRELOAD_CONCURRENCY = 2;
/** Idle warm-up: photos per page view (fewer on 3G, none on Save-Data/2G). */
export const PRELOAD_LIMIT = 8;
const PRELOAD_LIMIT_3G = 3;

/**
 * Photos this page view already requested (keyed by srcset, or src without
 * one); reset per gallery so a later page relies on the HTTP cache.
 */
let warmedImages = new Set<string>();
const selectionTokens = new WeakMap<HTMLElement, number>();
const mobileZoomBackgroundInertStates = new Map<HTMLElement, boolean>();
let activeController: AbortController | null = null;
let videoThemePromise: Promise<void> | null = null;
let bodyOverflowBeforeMobileZoom = "";

async function enhanceProductVideo(video: HTMLVideoElement): Promise<void> {
  if (typeof customElements === "undefined") return;
  if (!videoThemePromise) {
    videoThemePromise = import("@player.style/microvideo")
      .then(() => customElements.whenDefined("media-theme-microvideo"))
      .then(() => undefined)
      .catch((error: unknown) => {
        videoThemePromise = null;
        throw error;
      });
  }
  try {
    await videoThemePromise;
    if (!video.isConnected) return;
    video.controls = false;
    const player = video.closest<HTMLElement>("[data-product-video-player]");
    if (player) player.dataset.enhanced = "true";
  } catch {
    video.controls = true;
  }
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/**
 * The main photo's sources: the slot (`data-main-sizes`) and helper the SSR
 * markup used, so the mobile and desktop images and every preload agree on
 * one candidate.
 */
export function galleryMainSources(
  root: HTMLElement,
  url: string,
): ResponsiveImageSources {
  return responsiveImageSources(url, {
    width: GALLERY_IMAGE_WIDTHS.main,
    sizes: root.dataset.mainSizes || "100vw",
  });
}

/** Zoom detail: the 1600 rendition (or the master), never the upload. */
export function galleryZoomUrl(url: string): string {
  return mediaImageUrl(url, GALLERY_IMAGE_WIDTHS.zoom) || url;
}

function sourcesKey(sources: ResponsiveImageSources): string {
  return sources.srcset || sources.src;
}

/**
 * A detached image with the slot's srcset/sizes: the browser selects the
 * same candidate the visible image would at this viewport and DPR.
 */
function requestImage(
  sources: ResponsiveImageSources,
  fetchPriority: "high" | "low",
): HTMLImageElement {
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = fetchPriority;
  if (sources.srcset) {
    image.sizes = sources.sizes ?? "";
    image.srcset = sources.srcset;
  }
  image.src = sources.src;
  warmedImages.add(sourcesKey(sources));
  return image;
}

function settled(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
  });
}

/** Fetch (not decode) a photo so a later switch reads it from cache. */
function warmImage(
  sources: ResponsiveImageSources,
  fetchPriority: "high" | "low",
): Promise<void> {
  if (!sources.src || warmedImages.has(sourcesKey(sources)))
    return Promise.resolve();
  return settled(requestImage(sources, fetchPriority));
}

/**
 * Resolves when the photo is decoded (so swapping it in paints a complete
 * frame), when it fails, or after `timeoutMs`, whichever comes first.
 */
export function decodeBeforeSwap(
  sources: ResponsiveImageSources,
  timeoutMs = SWITCH_DECODE_TIMEOUT_MS,
): Promise<void> {
  const image = requestImage(sources, "high");
  const ready =
    typeof image.decode === "function"
      ? image.decode().catch(() => undefined)
      : settled(image);
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    void ready.then(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

function sameDocumentUrl(left: string | null, right: string): boolean {
  if (!left) return false;
  try {
    return (
      new URL(left, document.baseURI).href ===
      new URL(right, document.baseURI).href
    );
  } catch {
    return left === right;
  }
}

function showsSources(
  image: HTMLImageElement,
  sources: ResponsiveImageSources,
): boolean {
  return (
    sameDocumentUrl(image.getAttribute("src"), sources.src) &&
    (image.getAttribute("srcset") || undefined) === sources.srcset
  );
}

function applySources(
  image: HTMLImageElement,
  sources: ResponsiveImageSources,
  altText: string,
): void {
  if (sources.srcset) {
    image.setAttribute("sizes", sources.sizes ?? "");
    image.setAttribute("srcset", sources.srcset);
  } else {
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
  }
  image.setAttribute("src", sources.src);
  image.alt = altText;
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

function mediaKey(item: GalleryItem): string {
  return `${item.kind}:${item.productMediaId ?? item.mediaId ?? item.url}`;
}

function itemFromButton(button: HTMLButtonElement): GalleryItem | null {
  const kind = button.dataset.mediaKind;
  const url = button.dataset.mediaUrl;
  if ((kind !== "image" && kind !== "video") || !url) return null;

  return {
    kind,
    productMediaId: optional(button.dataset.productMediaId),
    mediaId: optional(button.dataset.mediaId),
    url,
    posterUrl: optional(button.dataset.posterUrl),
    altText: button.dataset.altText?.trim() || "Product media",
    source: "gallery",
    thumbnail: button,
  };
}

function fallbackItem(root: HTMLElement): GalleryItem | null {
  const url = root.dataset.fallbackUrl;
  if (!url) return null;
  return {
    kind: "image",
    productMediaId: null,
    mediaId: optional(root.dataset.fallbackMediaId),
    url,
    posterUrl: null,
    altText: root.dataset.fallbackAlt?.trim() || "Product image",
    source: "variant",
    thumbnail: null,
  };
}

function updateActiveThumbnails(
  root: HTMLElement,
  productMediaId: string | null,
): void {
  const rails = root.querySelectorAll<HTMLElement>("[data-thumbnail-rail]");
  rails.forEach((rail) => {
    const buttons = Array.from(
      rail.querySelectorAll<HTMLButtonElement>("[data-gallery-thumbnail]"),
    );
    const active = productMediaId
      ? buttons.find(
          (button) => button.dataset.productMediaId === productMediaId,
        )
      : null;
    const roving = active ?? buttons[0] ?? null;

    buttons.forEach((button) => {
      const isActive = button === active;
      button.setAttribute("aria-current", isActive ? "true" : "false");
      button.tabIndex = button === roving ? 0 : -1;
      button
        .querySelector<HTMLElement>("[data-thumb-ring]")
        ?.classList.toggle("!border-foreground", isActive);
    });
  });
}

function clearVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.removeAttribute("poster");
  video.preload = "none";
  video.load();
}

function setMobileZoomBackgroundInert(
  modal: HTMLElement,
  inert: boolean,
): void {
  if (!inert) {
    mobileZoomBackgroundInertStates.forEach((wasInert, element) => {
      element.inert = wasInert;
    });
    mobileZoomBackgroundInertStates.clear();
    return;
  }

  let branch: HTMLElement = modal;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    Array.from(parent.children).forEach((sibling) => {
      if (!(sibling instanceof HTMLElement) || sibling === branch) return;
      if (!mobileZoomBackgroundInertStates.has(sibling)) {
        mobileZoomBackgroundInertStates.set(sibling, sibling.inert);
      }
      sibling.inert = true;
    });
    if (parent === document.body) break;
    branch = parent;
  }
}

function dispatchChange(
  item: GalleryItem,
  zoomUrl: string | null,
  source: ProductMediaSelectionSource,
): void {
  window.dispatchEvent(
    new CustomEvent<ProductMediaChangeDetail>("product-media-change", {
      detail: {
        kind: item.kind,
        productMediaId: item.productMediaId,
        mediaId: item.mediaId,
        url: item.url,
        posterUrl: item.posterUrl,
        zoomUrl,
        altText: item.altText,
        source,
      },
    }),
  );
}

function galleryParts(root: HTMLElement) {
  return {
    desktopImageStage: root.querySelector<HTMLElement>(
      "[data-image-stage='desktop']",
    ),
    mobileImageStage: root.querySelector<HTMLElement>(
      "[data-image-stage='mobile']",
    ),
    videoStage: root.querySelector<HTMLElement>("[data-video-stage]"),
    video: root.querySelector<HTMLVideoElement>("[data-product-video]"),
    placeholder: root.querySelector<HTMLElement>("[data-video-placeholder]"),
    mobileImage: root.querySelector<HTMLImageElement>(
      "[data-mobile-main-image]",
    ),
    desktopImage: root.querySelector<HTMLImageElement>(
      "[data-desktop-main-image]",
    ),
    mobileTrigger: root.querySelector<HTMLElement>(
      "[data-mobile-image-trigger]",
    ),
  };
}

type GalleryParts = ReturnType<typeof galleryParts>;

function setActiveData(
  root: HTMLElement,
  item: GalleryItem,
  zoomUrl: string | null,
): void {
  root.dataset.activeMediaKey = mediaKey(item);
  root.dataset.activeMediaUrl = item.url;
  root.dataset.activeMediaAlt = item.altText;
  if (zoomUrl) root.dataset.activeMediaZoomUrl = zoomUrl;
  else delete root.dataset.activeMediaZoomUrl;
}

/**
 * SSR already renders the featured image/video and selected thumbnail. Seed
 * controller state without rewriting that media immediately before LCP. The
 * full mutation path remains the fallback for stale or client-constructed DOM.
 */
function adoptRenderedInitialItem(
  root: HTMLElement,
  item: GalleryItem,
): boolean {
  const parts = galleryParts(root);
  if (item.kind === "image") {
    if (
      !parts.mobileImage ||
      parts.mobileImageStage?.classList.contains("hidden") ||
      !showsSources(parts.mobileImage, galleryMainSources(root, item.url))
    )
      return false;
    setActiveData(root, item, galleryZoomUrl(item.url));
    return true;
  }

  if (
    !parts.video ||
    parts.videoStage?.classList.contains("hidden") ||
    !sameDocumentUrl(parts.video.getAttribute("src"), item.url)
  )
    return false;
  setActiveData(root, item, null);
  void enhanceProductVideo(parts.video);
  return true;
}

function showVideo(root: HTMLElement, parts: GalleryParts, item: GalleryItem) {
  const { video, videoStage } = parts;
  if (!video || !videoStage) return;
  parts.desktopImageStage?.classList.remove("lg:block");
  parts.desktopImageStage?.classList.add("hidden", "lg:!hidden");
  parts.mobileImageStage?.classList.add("hidden");
  videoStage.classList.remove("hidden");
  parts.mobileTrigger?.setAttribute("aria-disabled", "true");

  video.pause();
  video.preload = "metadata";
  video.setAttribute("aria-label", item.altText);
  if (item.posterUrl) video.poster = item.posterUrl;
  else video.removeAttribute("poster");
  if (video.getAttribute("src") !== item.url) {
    video.src = item.url;
    video.load();
  }
  void enhanceProductVideo(video);
  parts.placeholder?.classList.toggle("hidden", Boolean(item.posterUrl));
  closeMobileZoom(root);
}

function showImage(
  parts: GalleryParts,
  sources: ResponsiveImageSources,
  altText: string,
): void {
  if (parts.video?.getAttribute("src")) clearVideo(parts.video);
  parts.videoStage?.classList.add("hidden");
  parts.desktopImageStage?.classList.remove("lg:!hidden");
  parts.desktopImageStage?.classList.add("hidden", "lg:block");
  parts.mobileImageStage?.classList.remove("hidden");
  parts.mobileTrigger?.removeAttribute("aria-disabled");
  parts.placeholder?.classList.add("hidden");
  for (const image of [parts.mobileImage, parts.desktopImage]) {
    if (image) applySources(image, sources, altText);
  }
}

/**
 * Select a photo or video. Thumbnails, state and the change event update at
 * once; a photo is swapped into both main images (src, srcset, sizes, alt)
 * only after it decodes, so the slot never shows a blank or half-decoded
 * frame. A newer selection cancels an older pending swap.
 */
function setSelectedItem(
  root: HTMLElement,
  item: GalleryItem,
  source: ProductMediaSelectionSource,
): void {
  if (root.dataset.activeMediaKey === mediaKey(item) && source !== "variant")
    return;
  const token = (selectionTokens.get(root) ?? 0) + 1;
  selectionTokens.set(root, token);
  const parts = galleryParts(root);
  updateActiveThumbnails(root, item.thumbnail ? item.productMediaId : null);

  if (item.kind === "video") {
    setActiveData(root, item, null);
    showVideo(root, parts, item);
    dispatchChange(item, null, source);
    return;
  }

  const sources = galleryMainSources(root, item.url);
  const zoomUrl = galleryZoomUrl(item.url);
  setActiveData(root, item, zoomUrl);
  dispatchChange(item, zoomUrl, source);

  const present = () => {
    if (selectionTokens.get(root) === token)
      showImage(parts, sources, item.altText);
  };
  const shown =
    !parts.mobileImageStage?.classList.contains("hidden") &&
    [parts.mobileImage, parts.desktopImage].every(
      (image) => !image || showsSources(image, sources),
    );
  if (source === "initial" || shown) present();
  else void decodeBeforeSwap(sources).then(present);
}

function closeMobileZoom(root: HTMLElement): void {
  const modal = root.querySelector<HTMLElement>("[data-mobile-zoom-modal]");
  if (!modal || modal.getAttribute("aria-hidden") === "true") return;
  modal.inert = true;
  modal.classList.add("opacity-0", "pointer-events-none");
  modal.setAttribute("aria-hidden", "true");
  setMobileZoomBackgroundInert(modal, false);
  document.body.style.overflow = bodyOverflowBeforeMobileZoom;
}

function bindThumbnailRail(
  rail: HTMLElement,
  signal: AbortSignal,
  select: (
    button: HTMLButtonElement,
    source: ProductMediaSelectionSource,
  ) => void,
  warm: (button: HTMLButtonElement) => void,
): void {
  const buttons = Array.from(
    rail.querySelectorAll<HTMLButtonElement>("[data-gallery-thumbnail]"),
  );
  const hover = window.matchMedia("(hover: hover)").matches;
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(button, "gallery"), {
      signal,
    });
    button.addEventListener(
      "keydown",
      (event) => {
        let nextIndex: number | null = null;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          nextIndex = (index + 1) % buttons.length;
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          nextIndex = (index - 1 + buttons.length) % buttons.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = buttons.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        const target = buttons[nextIndex];
        if (!target) return;
        target.focus();
        select(target, "gallery");
      },
      { signal },
    );

    if (button.dataset.mediaKind !== "image") return;
    // Intent: start the fetch before the click lands.
    button.addEventListener("touchstart", () => warm(button), {
      passive: true,
      signal,
    });
    button.addEventListener("focus", () => warm(button), { signal });
    if (hover) {
      let hoverTimer: number | null = null;
      button.addEventListener(
        "mouseenter",
        () => {
          warm(button);
          hoverTimer = window.setTimeout(() => select(button, "gallery"), 40);
        },
        { signal },
      );
      button.addEventListener(
        "mouseleave",
        () => {
          if (hoverTimer !== null) window.clearTimeout(hoverTimer);
        },
        { signal },
      );
    }
  });
}

/**
 * Photos worth warming after the page loads, best first and without
 * duplicates: SKU photos (what a variant switch shows), the product photo
 * for SKUs without one, then the rest of the gallery. The active photo is
 * already on screen; videos are never preloaded.
 */
export function galleryPreloadQueue(
  root: HTMLElement,
  buttons: HTMLButtonElement[],
  variants: ReadonlyArray<{ imageId: string | null }>,
): string[] {
  const queue: string[] = [];
  const add = (url: string | undefined) => {
    if (url && url !== root.dataset.activeMediaUrl && !queue.includes(url))
      queue.push(url);
  };
  const images = buttons.filter((button) => button.dataset.mediaKind === "image");
  const skuImageIds = new Set(variants.map((variant) => variant.imageId));
  images
    .filter((button) => skuImageIds.has(button.dataset.productMediaId ?? ""))
    .forEach((button) => add(button.dataset.mediaUrl));
  if (skuImageIds.has(null)) add(root.dataset.fallbackUrl);
  images.forEach((button) => add(button.dataset.mediaUrl));
  return queue;
}

function preloadBudget(): number {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  )
    return 0;
  return connection?.effectiveType === "3g" ? PRELOAD_LIMIT_3G : PRELOAD_LIMIT;
}

/**
 * Fetch `urls` in the main slot's candidate, `concurrency` at a time, at low
 * priority. Stops starting new requests once `signal` aborts.
 */
export async function preloadGalleryImages(
  root: HTMLElement,
  urls: string[],
  signal: AbortSignal,
  concurrency = PRELOAD_CONCURRENCY,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < urls.length) {
      const url = urls[next++]!;
      await warmImage(galleryMainSources(root, url), "low");
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker),
  );
}

/** Run `task` once the page has loaded and the main thread is idle. */
function afterPageLoadIdle(signal: AbortSignal, task: () => void): void {
  const idle = () => {
    if (signal.aborted) return;
    if (window.requestIdleCallback)
      window.requestIdleCallback(task, { timeout: 3000 });
    else window.setTimeout(task, 200);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true, signal });
}

function bindScrollIndicator(
  root: HTMLElement,
  containerName: string,
  direction: "up" | "down",
  signal: AbortSignal,
): void {
  const container = root.querySelector<HTMLElement>(
    `[data-thumbnail-rail="${containerName}"]`,
  );
  const control = root.querySelector<HTMLButtonElement>(
    `[data-scroll-control="${containerName}-${direction}"]`,
  );
  if (!container || !control) return;

  const update = () => {
    const { scrollTop, scrollHeight, clientHeight } = container;
    const visible =
      direction === "up"
        ? scrollTop > 10
        : scrollHeight > clientHeight &&
          Math.round(scrollTop + clientHeight) < scrollHeight - 10;
    requestAnimationFrame(() => {
      control.classList.toggle("opacity-0", !visible);
      control.classList.toggle("pointer-events-none", !visible);
      control.tabIndex = visible ? 0 : -1;
    });
  };

  control.addEventListener(
    "click",
    () =>
      container.scrollBy({
        top: direction === "up" ? -150 : 150,
        behavior: scrollBehavior(),
      }),
    { signal },
  );
  container.addEventListener("scroll", update, { passive: true, signal });
  window.addEventListener("resize", update, { passive: true, signal });
  requestAnimationFrame(update);
}

function bindMobileZoom(root: HTMLElement, signal: AbortSignal): void {
  const trigger = root.querySelector<HTMLElement>(
    "[data-mobile-image-trigger]",
  );
  const modal = root.querySelector<HTMLElement>("[data-mobile-zoom-modal]");
  const close = root.querySelector<HTMLButtonElement>(
    "[data-close-mobile-zoom]",
  );
  const image = root.querySelector<HTMLImageElement>("[data-fullscreen-image]");
  const container = root.querySelector<HTMLElement>("[data-panzoom-container]");
  if (!trigger || !modal || !close || !image || !container) return;

  let scale = 1;
  let pointX = 0;
  let pointY = 0;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let initialPinchDistance = 0;
  let initialScale = 1;
  let lastTap = 0;

  const transform = () => {
    image.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
  };
  const reset = () => {
    scale = 1;
    pointX = 0;
    pointY = 0;
    transform();
  };
  const closeModal = () => {
    closeMobileZoom(root);
    trigger.focus();
  };
  const open = () => {
    if (trigger.getAttribute("aria-disabled") === "true") return;
    const active = root.dataset.activeMediaKey;
    if (!active?.startsWith("image:")) return;
    const current = root.querySelector<HTMLImageElement>(
      "[data-mobile-main-image]",
    );
    const detailUrl =
      root.dataset.activeMediaZoomUrl || current?.currentSrc || current?.src;
    if (!detailUrl) return;
    image.src = detailUrl;
    image.alt = current?.alt
      ? `${current.alt} — zoomed view`
      : "Zoomed product image";
    reset();
    bodyOverflowBeforeMobileZoom = document.body.style.overflow;
    setMobileZoomBackgroundInert(modal, true);
    modal.inert = false;
    modal.classList.remove("opacity-0", "pointer-events-none");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    close.focus();
  };

  trigger.addEventListener("click", open, { signal });
  close.addEventListener("click", closeModal, { signal });
  signal.addEventListener("abort", () => closeMobileZoom(root), { once: true });
  modal.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") closeModal();
      if (event.key === "Tab") {
        event.preventDefault();
        close.focus();
      }
    },
    { signal },
  );

  container.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        initialPinchDistance = Math.hypot(
          event.touches[0]!.clientX - event.touches[1]!.clientX,
          event.touches[0]!.clientY - event.touches[1]!.clientY,
        );
        initialScale = scale;
      } else if (event.touches.length === 1 && scale > 1) {
        dragging = true;
        startX = event.touches[0]!.clientX - pointX;
        startY = event.touches[0]!.clientY - pointY;
      }
    },
    { passive: false, signal },
  );
  container.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length === 2 && initialPinchDistance > 0) {
        event.preventDefault();
        const distance = Math.hypot(
          event.touches[0]!.clientX - event.touches[1]!.clientX,
          event.touches[0]!.clientY - event.touches[1]!.clientY,
        );
        scale = Math.min(
          Math.max(1, initialScale * (distance / initialPinchDistance)),
          4,
        );
        transform();
      } else if (event.touches.length === 1 && dragging) {
        event.preventDefault();
        pointX = event.touches[0]!.clientX - startX;
        pointY = event.touches[0]!.clientY - startY;
        transform();
      }
    },
    { passive: false, signal },
  );
  container.addEventListener(
    "touchend",
    () => {
      dragging = false;
      if (scale < 1.1) reset();
    },
    { signal },
  );
  container.addEventListener(
    "click",
    () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (scale > 1) reset();
        else {
          scale = 2.5;
          transform();
        }
      }
      lastTap = now;
    },
    { signal },
  );
}

function preferredThumbnail(
  buttons: HTMLButtonElement[],
  predicate: (button: HTMLButtonElement) => boolean,
): HTMLButtonElement | null {
  const matches = buttons.filter(predicate);
  if (matches.length === 0) return null;
  const rail = window.matchMedia("(min-width: 1024px)").matches
    ? "desktop"
    : "mobile";
  return (
    matches.find(
      (button) =>
        button.closest<HTMLElement>("[data-thumbnail-rail]")?.dataset
          .thumbnailRail === rail,
    ) ?? matches[0]!
  );
}

export function initProductMediaGallery(
  root = document.querySelector<HTMLElement>("[data-product-gallery]"),
): void {
  if (!root) return;
  activeController?.abort();
  warmedImages = new Set();
  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;

  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-gallery-thumbnail]"),
  );
  const selectButton = (
    button: HTMLButtonElement,
    source: ProductMediaSelectionSource,
  ) => {
    const item = itemFromButton(button);
    if (item) setSelectedItem(root, item, source);
  };

  const warmButton = (button: HTMLButtonElement) => {
    const url = button.dataset.mediaUrl;
    if (url) void warmImage(galleryMainSources(root, url), "high");
  };

  root
    .querySelectorAll<HTMLElement>("[data-thumbnail-rail]")
    .forEach((rail) => {
      bindThumbnailRail(rail, signal, selectButton, warmButton);
    });
  for (const rail of ["desktop", "mobile"] as const) {
    bindScrollIndicator(root, rail, "up", signal);
    bindScrollIndicator(root, rail, "down", signal);
  }
  bindMobileZoom(root, signal);
  const video = root.querySelector<HTMLVideoElement>("[data-product-video]");
  const videoPlaceholder = root.querySelector<HTMLElement>(
    "[data-video-placeholder]",
  );
  video?.addEventListener(
    "playing",
    () => videoPlaceholder?.classList.add("hidden"),
    {
      signal,
    },
  );

  window.addEventListener(
    "product-media-select",
    (event) => {
      const target = event.detail.productMediaId
        ? preferredThumbnail(
            buttons,
            (button) =>
              button.dataset.productMediaId === event.detail.productMediaId &&
              button.dataset.mediaKind === "image",
          )
        : null;
      if (target) {
        selectButton(target, event.detail.source);
        target.scrollIntoView({ behavior: "auto", block: "nearest" });
        return;
      }

      const fallbackMediaId = root.dataset.fallbackMediaId;
      const attachedFallback = fallbackMediaId
        ? preferredThumbnail(
            buttons,
            (button) =>
              button.dataset.mediaId === fallbackMediaId &&
              button.dataset.mediaKind === "image",
          )
        : null;
      if (attachedFallback) {
        selectButton(attachedFallback, event.detail.source);
        attachedFallback.scrollIntoView({
          behavior: "auto",
          block: "nearest",
        });
        return;
      }

      const fallback = fallbackItem(root);
      if (fallback) setSelectedItem(root, fallback, event.detail.source);
    },
    { signal },
  );

  const initialId = root.dataset.initialProductMediaId;
  const initial =
    buttons.find((button) => button.dataset.productMediaId === initialId) ??
    buttons[0];
  if (initial) {
    const item = itemFromButton(initial);
    if (item && !adoptRenderedInitialItem(root, item)) {
      setSelectedItem(root, item, "initial");
    }
  } else {
    const fallback = fallbackItem(root);
    if (fallback) setSelectedItem(root, fallback, "initial");
  }
  bindDesktopZoomWhenEligible(root, signal);

  // Switching must feel instant: once the page has loaded, warm the photos
  // a switch can show, in the candidate the main slot would pick.
  afterPageLoadIdle(signal, () => {
    if (signal.aborted) return;
    const queue = galleryPreloadQueue(root, buttons, loadVariantsFromDOM());
    void preloadGalleryImages(root, queue.slice(0, preloadBudget()), signal);
  });
}

type DesktopZoomModule = typeof import("./product-desktop-zoom-controller");

export function bindDesktopZoomWhenEligible(
  root: HTMLElement,
  signal: AbortSignal,
  loadController: () => Promise<DesktopZoomModule> = () =>
    import("./product-desktop-zoom-controller"),
): void {
  const desktopQuery = window.matchMedia("(min-width: 1024px)");
  let requested = false;
  let removeChangeListener: () => void = () => {};

  const requestController = () => {
    if (requested || signal.aborted || !desktopQuery.matches) return;
    requested = true;
    removeChangeListener();
    void loadController()
      .then(({ bindDesktopZoom }) => {
        if (!signal.aborted) bindDesktopZoom(root, signal);
      })
      .catch(() => undefined);
  };

  const handleChange = () => requestController();
  if (typeof desktopQuery.addEventListener === "function") {
    desktopQuery.addEventListener("change", handleChange);
    removeChangeListener = () =>
      desktopQuery.removeEventListener("change", handleChange);
  }

  signal.addEventListener("abort", removeChangeListener, { once: true });
  requestController();
}
