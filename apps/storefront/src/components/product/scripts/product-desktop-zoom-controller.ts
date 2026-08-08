const imageCache = new Map<string, HTMLImageElement>();
const imagePreloads = new Map<string, Promise<boolean>>();

function preloadImage(url: string): Promise<boolean> {
  if (imageCache.has(url)) return Promise.resolve(true);
  const existing = imagePreloads.get(url);
  if (existing) return existing;
  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.fetchPriority = "high";
    image.onload = async () => {
      try {
        await image.decode?.();
      } catch {
        // A successfully loaded image remains usable when decode rejects.
      }
      imageCache.set(url, image);
      imagePreloads.delete(url);
      resolve(true);
    };
    image.onerror = () => {
      imagePreloads.delete(url);
      resolve(false);
    };
    image.src = url;
  });
  imagePreloads.set(url, request);
  return request;
}

function canLoadHighResolutionImage(): boolean {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  return (
    !connection?.saveData && (!connection || connection.effectiveType === "4g")
  );
}

function cssUrl(url: string): string {
  return `url(${JSON.stringify(url)})`;
}

export function bindDesktopZoom(root: HTMLElement, signal: AbortSignal): void {
  const container = root.querySelector<HTMLElement>(
    "[data-desktop-image-zoom]",
  );
  const image = root.querySelector<HTMLImageElement>(
    "[data-desktop-main-image]",
  );
  const layer = root.querySelector<HTMLElement>("[data-desktop-zoom-layer]");
  if (!container || !image || !layer) return;

  let active = false;
  let frame: number | null = null;
  let latestPosition = { x: 0.5, y: 0.5 };

  const setBackground = (url: string) => {
    layer.style.backgroundImage = cssUrl(url);
  };
  const close = () => {
    active = false;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    image.classList.remove("opacity-0");
    layer.classList.add("opacity-0");
    layer.style.willChange = "auto";
  };
  const open = () => {
    if (!root.dataset.activeMediaKey?.startsWith("image:")) return;
    const activeKey = root.dataset.activeMediaKey;
    const displayUrl =
      root.dataset.activeMediaUrl || image.currentSrc || image.src;
    const zoomUrl = root.dataset.activeMediaZoomUrl || displayUrl;
    if (!displayUrl || !zoomUrl) return;
    active = true;

    setBackground(imageCache.has(zoomUrl) ? zoomUrl : displayUrl);
    image.classList.add("opacity-0");
    layer.classList.remove("opacity-0");
    layer.style.backgroundSize = "200%";
    layer.style.backgroundPosition = "50% 50%";
    layer.style.willChange = "background-position";

    if (imageCache.has(zoomUrl) || !canLoadHighResolutionImage()) return;
    void preloadImage(zoomUrl).then((loaded) => {
      if (!active || root.dataset.activeMediaKey !== activeKey) return;
      if (loaded) setBackground(zoomUrl);
    });
  };
  const move = (event: MouseEvent) => {
    if (!active) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    latestPosition = {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      layer.style.backgroundPosition = `${latestPosition.x * 100}% ${latestPosition.y * 100}%`;
    });
  };

  container.addEventListener("mouseenter", open, { signal });
  container.addEventListener("mousemove", move, { signal });
  container.addEventListener("mouseleave", close, { signal });
  window.addEventListener(
    "product-media-change",
    (event) => {
      close();
      if (event.detail.kind === "image") {
        setBackground(event.detail.previewUrl || event.detail.url);
      }
    },
    { signal },
  );
  signal.addEventListener("abort", close, { once: true });

  setBackground(
    root.dataset.activeMediaUrl ||
      image.currentSrc ||
      image.src,
  );
}
