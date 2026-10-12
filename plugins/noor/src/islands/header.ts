// The header's behaviour: marks the shell once the page scrolls
// (`data-scrolled`: the overlay header turns solid, the sticky one gains its
// shadow) and turns the announcements every five seconds, pausing on hover
// and focus, never for buyers who ask for less motion.

import { defineIsland } from "@scalius/plugin-sdk/island";

const TURN_MS = 5000;

export default defineIsland((element) => {
  const shell = element.closest<HTMLElement>(".noor-header-shell");
  if (!shell) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    shell.toggleAttribute("data-scrolled", window.scrollY > 8);
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  // Core wraps sections in display-contents containers; the first actual
  // section is the layout authority, not the first app or the first hero.
  const firstSection = document.querySelector("main")?.querySelector("section");
  shell.toggleAttribute("data-overlay-ready", Boolean(
    shell.classList.contains("is-transparent")
    && firstSection?.matches(".noor-s-hero, .noor-s-slideshow")
    && firstSection.querySelector(".noor-hero.is-overlay .noor-hero-media img"),
  ));
  window.addEventListener("scroll", onScroll, { passive: true });

  const items = [...element.querySelectorAll<HTMLElement>("[data-announce-list] > li")];
  let timer: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  const list = items[0]?.parentElement;
  const pause = () => { paused = true; };
  const resume = () => { paused = false; };
  if (items.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let current = 0;
    timer = setInterval(() => {
      if (paused || document.visibilityState !== "visible") return;
      items[current]!.removeAttribute("data-active");
      items[current]!.setAttribute("aria-hidden", "true");
      items[current]!.inert = true;
      current = (current + 1) % items.length;
      items[current]!.setAttribute("data-active", "");
      items[current]!.removeAttribute("aria-hidden");
      items[current]!.inert = false;
    }, TURN_MS);
    list?.addEventListener("pointerenter", pause);
    list?.addEventListener("pointerleave", resume);
    list?.addEventListener("focusin", pause);
    list?.addEventListener("focusout", resume);
  }
  return () => {
    shell.removeAttribute("data-overlay-ready");
    window.removeEventListener("scroll", onScroll);
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearInterval(timer);
    list?.removeEventListener("pointerenter", pause);
    list?.removeEventListener("pointerleave", resume);
    list?.removeEventListener("focusin", pause);
    list?.removeEventListener("focusout", resume);
  };
});
