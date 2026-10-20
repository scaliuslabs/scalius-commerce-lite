// The hero carousel: one slide at a time, the side arrows, and autoplay
// that pauses on hover, focus and hidden tabs and never runs for buyers who
// ask for less motion. Without it the slides are a horizontally scrolling
// row that snaps.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ interval?: number }>((element, props) => {
  const track = element.querySelector<HTMLElement>("[data-track]");
  const slides = Array.from(element.querySelectorAll<HTMLElement>("[data-slide]"));
  if (!track || slides.length < 2) return;
  const prev = element.querySelector<HTMLButtonElement>("[data-prev]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  let index = 0;
  let timer = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const go = (to: number) => {
    index = (to + slides.length) % slides.length;
    track.scrollTo({ left: slides[index]!.offsetLeft, behavior: reduce ? "auto" : "smooth" });
  };
  const stop = () => { if (timer) clearInterval(timer); timer = 0; };
  const start = () => {
    stop();
    if (reduce || document.hidden) return;
    timer = window.setInterval(() => go(index + 1), Math.max(3, props.interval ?? 6) * 1000);
  };
  const onPrev = () => { go(index - 1); start(); };
  const onNext = () => { go(index + 1); start(); };
  const onVisibility = () => (document.hidden ? stop() : start());
  prev?.addEventListener("click", onPrev);
  next?.addEventListener("click", onNext);
  element.addEventListener("pointerenter", stop);
  element.addEventListener("pointerleave", start);
  element.addEventListener("focusin", stop);
  element.addEventListener("focusout", start);
  document.addEventListener("visibilitychange", onVisibility);
  start();
  return () => {
    stop();
    prev?.removeEventListener("click", onPrev);
    next?.removeEventListener("click", onNext);
    element.removeEventListener("pointerenter", stop);
    element.removeEventListener("pointerleave", start);
    element.removeEventListener("focusin", stop);
    element.removeEventListener("focusout", start);
    document.removeEventListener("visibilitychange", onVisibility);
  };
});
