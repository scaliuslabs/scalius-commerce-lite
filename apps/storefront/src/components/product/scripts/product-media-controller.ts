export type ProductMediaSelectionSource = "initial" | "gallery" | "variant";

export interface ProductMediaChangeDetail {
  kind: "image" | "video";
  productMediaId: string | null;
  mediaId: string | null;
  url: string;
  previewUrl: string | null;
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

interface GalleryItem extends ProductMediaChangeDetail {
  thumbnail: HTMLButtonElement | null;
}

interface NetworkConnectionInfo {
  saveData?: boolean;
  effectiveType?: string;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkConnectionInfo;
}

const imageCache = new Map<string, HTMLImageElement>();
const imagePreloads = new Map<string, Promise<void>>();
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

function preloadImage(
  url: string,
  fetchPriority: "high" | "low" | "auto" = "auto",
): Promise<void> {
  if (!url || imageCache.has(url)) return Promise.resolve();
  const existing = imagePreloads.get(url);
  if (existing) return existing;
  const request = new Promise<void>((resolve) => {
    const image = new Image();
    image.fetchPriority = fetchPriority;
    image.onload = async () => {
      try {
        await image.decode?.();
      } catch {
        // A successful load is still usable when decode() is unavailable or rejects.
      }
      imageCache.set(url, image);
      imagePreloads.delete(url);
      resolve();
    };
    image.onerror = () => {
      imagePreloads.delete(url);
      resolve();
    };
    image.src = url;
  });
  imagePreloads.set(url, request);
  return request;
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
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
    previewUrl: kind === "image" ? optional(button.dataset.previewUrl) : null,
    posterUrl: optional(button.dataset.posterUrl),
    zoomUrl: kind === "image" ? optional(button.dataset.zoomUrl) : null,
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
    productMediaId: optional(root.dataset.fallbackProductMediaId),
    mediaId: optional(root.dataset.fallbackMediaId),
    url,
    previewUrl: null,
    posterUrl: null,
    zoomUrl: optional(root.dataset.fallbackZoomUrl),
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
        ?.classList.toggle("!border-black", isActive);
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

function dispatchChange(item: GalleryItem): void {
  window.dispatchEvent(
    new CustomEvent<ProductMediaChangeDetail>("product-media-change", {
      detail: {
        kind: item.kind,
        productMediaId: item.productMediaId,
        mediaId: item.mediaId,
        url: item.url,
        previewUrl: item.previewUrl,
        posterUrl: item.posterUrl,
        zoomUrl: item.zoomUrl,
        altText: item.altText,
        source: item.source,
      },
    }),
  );
}

function setSelectedItem(
  root: HTMLElement,
  item: GalleryItem,
  source: ProductMediaSelectionSource,
): void {
  const currentKey = `${item.kind}:${item.productMediaId ?? item.mediaId ?? item.url}`;
  if (root.dataset.activeMediaKey === currentKey && source !== "variant")
    return;
  root.dataset.activeMediaKey = currentKey;

  const desktopImageStage = root.querySelector<HTMLElement>(
    "[data-image-stage='desktop']",
  );
  const mobileImageStage = root.querySelector<HTMLElement>(
    "[data-image-stage='mobile']",
  );
  const videoStage = root.querySelector<HTMLElement>("[data-video-stage]");
  const video = root.querySelector<HTMLVideoElement>("[data-product-video]");
  const placeholder = root.querySelector<HTMLElement>(
    "[data-video-placeholder]",
  );
  const mobileImage = root.querySelector<HTMLImageElement>(
    "[data-mobile-main-image]",
  );
  const desktopImage = root.querySelector<HTMLImageElement>(
    "[data-desktop-main-image]",
  );
  const mobileTrigger = root.querySelector<HTMLElement>(
    "[data-mobile-image-trigger]",
  );

  updateActiveThumbnails(root, item.thumbnail ? item.productMediaId : null);
  root.dataset.activeMediaUrl = item.url;
  root.dataset.activeMediaZoomUrl = item.zoomUrl || item.url;
  root.dataset.activeMediaAlt = item.altText;

  if (item.kind === "video" && video && videoStage) {
    desktopImageStage?.classList.remove("lg:block");
    desktopImageStage?.classList.add("hidden", "lg:!hidden");
    mobileImageStage?.classList.add("hidden");
    videoStage.classList.remove("hidden");
    mobileTrigger?.setAttribute("aria-disabled", "true");

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
    placeholder?.classList.toggle("hidden", Boolean(item.posterUrl));
    closeMobileZoom(root);
  } else {
    if (video) clearVideo(video);
    videoStage?.classList.add("hidden");
    desktopImageStage?.classList.remove("lg:!hidden");
    desktopImageStage?.classList.add("hidden", "lg:block");
    mobileImageStage?.classList.remove("hidden");
    mobileTrigger?.removeAttribute("aria-disabled");
    placeholder?.classList.add("hidden");

    const displayUrl = item.url;
    const presentedItem = {
      ...item,
      previewUrl: null,
    };
    root.dataset.activeMediaDisplayUrl = displayUrl;

    if (mobileImage) {
      mobileImage.removeAttribute("srcset");
      mobileImage.removeAttribute("sizes");
      mobileImage.src = displayUrl;
      mobileImage.alt = item.altText;
    }
    if (desktopImage) {
      desktopImage.src = displayUrl;
      desktopImage.alt = item.altText;
    }

    dispatchChange({ ...presentedItem, source });
    return;
  }

  dispatchChange({ ...item, source });
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
): void {
  const buttons = Array.from(
    rail.querySelectorAll<HTMLButtonElement>("[data-gallery-thumbnail]"),
  );
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

    if (
      button.dataset.mediaKind === "image" &&
      window.matchMedia("(hover: hover)").matches
    ) {
      let hoverTimer: number | null = null;
      button.addEventListener(
        "mouseenter",
        () => {
          if (button.dataset.mediaUrl) {
            void preloadImage(button.dataset.mediaUrl, "high");
          }
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
    const detailUrl = current?.dataset.zoomUrl || current?.src;
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

  window.addEventListener(
    "product-media-change",
    (event) => {
      if (event.detail.kind !== "image") return;
      const current = root.querySelector<HTMLImageElement>(
        "[data-mobile-main-image]",
      );
      if (current)
        current.dataset.zoomUrl = event.detail.zoomUrl || event.detail.url;
      if (image)
        image.dataset.zoomSrc = event.detail.zoomUrl || event.detail.url;
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

function canWarmVariantImages(): boolean {
  const connection = (navigator as NavigatorWithConnection).connection;
  if (connection?.saveData) return false;
  return (
    !connection?.effectiveType ||
    !["slow-2g", "2g", "3g"].includes(connection.effectiveType)
  );
}

function scheduleVariantImagePreload(
  root: HTMLElement,
  signal: AbortSignal,
): void {
  if (!canWarmVariantImages()) return;
  const currentUrl = root.dataset.activeMediaUrl;
  const limit = window.matchMedia("(min-width: 1024px)").matches ? 4 : 2;
  const urls = Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      "[data-thumbnail-rail='desktop'] [data-gallery-thumbnail][data-media-kind='image'][data-variant-image='true']",
    ),
  )
    .flatMap((button) =>
      button.dataset.mediaUrl ? [button.dataset.mediaUrl] : [],
    )
    .filter(
      (url, index, values) =>
        url !== currentUrl && values.indexOf(url) === index,
    )
    .slice(0, limit);
  if (urls.length === 0) return;

  const run = () => {
    if (signal.aborted || !root.isConnected) return;
    urls.forEach((url) => void preloadImage(url, "low"));
  };
  const requestIdleCallback = window.requestIdleCallback;
  if (requestIdleCallback) requestIdleCallback(run, { timeout: 1_000 });
  else window.setTimeout(run, 300);
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

  root
    .querySelectorAll<HTMLElement>("[data-thumbnail-rail]")
    .forEach((rail) => {
      bindThumbnailRail(rail, signal, selectButton);
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
  if (initial) selectButton(initial, "initial");
  else {
    const fallback = fallbackItem(root);
    if (fallback) setSelectedItem(root, fallback, "initial");
  }
  scheduleVariantImagePreload(root, signal);
}
