/**
 * Poster first, player on press. A video facade is a link (it works without
 * JavaScript) over a fixed-ratio box: the poster, a play button and nothing
 * else, so the page loads no player, no video bytes and no iframe until the
 * buyer asks. Pressing it swaps in the player inside the same box (no layout
 * shift): an uploaded file becomes `<video controls>`, a YouTube or Vimeo
 * link its privacy-enhanced iframe. Nothing starts on its own, so nothing
 * ever plays sound unasked; the press is the buyer's gesture.
 */

export type VideoFacadeKind = "file" | "embed";

const PLAYER_CLASS = "absolute inset-0 z-10 h-full w-full border-0 bg-black object-contain";

function embedAutoplayUrl(src: string): string {
  const url = new URL(src, window.location.href);
  url.searchParams.set("autoplay", "1");
  if (url.hostname.endsWith("youtube-nocookie.com")) url.searchParams.set("rel", "0");
  return url.toString();
}

/** Removes a mounted player (pausing it first) and shows the facade again. */
export function stopVideoFacade(box: ParentNode | null): void {
  if (!box) return;
  box.querySelectorAll<HTMLElement>("[data-video-player]").forEach((player) => {
    if (player instanceof HTMLVideoElement) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    player.remove();
  });
  box.querySelector<HTMLElement>("[data-video-facade]")?.removeAttribute("hidden");
}

/** Mounts the player for a facade in its box and starts it. */
export function playVideoFacade(facade: HTMLElement): HTMLElement | null {
  const box = facade.parentElement;
  const src = facade.dataset.videoSrc;
  if (!box || !src) return null;
  stopVideoFacade(box);
  const title = facade.dataset.videoTitle || "Product video";
  let player: HTMLElement;
  if (facade.dataset.videoKind === "embed") {
    const frame = document.createElement("iframe");
    frame.src = embedAutoplayUrl(src);
    frame.title = title;
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    player = frame;
  } else {
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    const poster = facade.querySelector<HTMLImageElement>("[data-video-poster]");
    if (poster && !poster.hidden && poster.currentSrc) video.poster = poster.currentSrc;
    video.src = src;
    video.setAttribute("aria-label", title);
    video.dataset.productVideo = "";
    player = video;
  }
  player.className = PLAYER_CLASS;
  player.dataset.videoPlayer = "";
  box.append(player);
  facade.hidden = true;
  if (player instanceof HTMLVideoElement) void player.play().catch(() => undefined);
  player.focus({ preventScroll: true });
  return player;
}

/** Binds every facade under `root` that no one bound yet (content blocks). */
export function bindVideoFacades(root: ParentNode = document, signal?: AbortSignal): void {
  root.querySelectorAll<HTMLElement>("[data-video-facade]:not([data-gallery-video])").forEach((facade) => {
    if (facade.dataset.videoBound === "true") return;
    facade.dataset.videoBound = "true";
    facade.addEventListener("click", (event) => {
      event.preventDefault();
      playVideoFacade(facade);
    }, signal ? { signal } : undefined);
  });
}
