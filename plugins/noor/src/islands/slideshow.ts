// Slideshows and quote rows: the track scrolls and snaps on its own; this
// adds previous and next, dots that follow the visible slide, arrow keys,
// and autoplay that pauses on hover, focus, a hidden tab and for buyers
// who ask for less motion.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ autoplay?: boolean; interval?: number }>((element, props) => {
  const track = element.querySelector<HTMLElement>("[data-track]");
  const slides = track ? [...track.querySelectorAll<HTMLElement>("[data-slide]")] : [];
  if (!track || slides.length < 2) return;
  const controls = element.querySelector<HTMLElement>("[data-controls]");
  const dots = [...element.querySelectorAll<HTMLButtonElement>("[data-dot]")];
  controls?.removeAttribute("hidden");

  let current = 0;
  const go = (index: number) => {
    const next = (index + slides.length) % slides.length;
    track.scrollTo({ left: slides[next]!.offsetLeft - track.offsetLeft, behavior: "smooth" });
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      current = slides.indexOf(entry.target as HTMLElement);
      dots.forEach((dot, index) => dot.setAttribute("aria-current", index === current ? "true" : "false"));
    }
  }, { root: track, threshold: 0.6 });
  slides.forEach((slide) => observer.observe(slide));

  const prev = element.querySelector<HTMLButtonElement>("[data-prev]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  const onPrev = () => go(current - 1);
  const onNext = () => go(current + 1);
  prev?.addEventListener("click", onPrev);
  next?.addEventListener("click", onNext);
  const onDot = (event: Event) => go(Number((event.currentTarget as HTMLElement).dataset.dot));
  dots.forEach((dot) => dot.addEventListener("click", onDot));
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") { event.preventDefault(); onNext(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); onPrev(); }
  };
  track.addEventListener("keydown", onKey);

  let timer: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (props?.autoplay && !reduced) {
    const seconds = Math.max(3, Math.min(12, Number(props.interval) || 6));
    timer = setInterval(() => {
      if (!paused && document.visibilityState === "visible") go(current + 1);
    }, seconds * 1000);
  }
  const pause = () => { paused = true; };
  const resume = () => { paused = false; };
  element.addEventListener("pointerenter", pause);
  element.addEventListener("pointerleave", resume);
  element.addEventListener("focusin", pause);
  element.addEventListener("focusout", resume);

  return () => {
    observer.disconnect();
    if (timer) clearInterval(timer);
    prev?.removeEventListener("click", onPrev);
    next?.removeEventListener("click", onNext);
    dots.forEach((dot) => dot.removeEventListener("click", onDot));
    track.removeEventListener("keydown", onKey);
    element.removeEventListener("pointerenter", pause);
    element.removeEventListener("pointerleave", resume);
    element.removeEventListener("focusin", pause);
    element.removeEventListener("focusout", resume);
  };
});
