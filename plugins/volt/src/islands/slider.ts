// The hero slider: the slides sit in a scroll-snapping track that works by
// touch and keyboard without this; it adds arrows, dots and autoplay (paused
// on hover, focus, a hidden tab and for buyers who ask for reduced motion).

import { defineIsland } from "@scalius/plugin-sdk/island";

export interface SliderProps {
  autoplay: boolean;
  interval: number;
}

export default defineIsland<SliderProps>((element, props) => {
  const track = element.querySelector<HTMLElement>("[data-track]");
  if (!track) return;
  const slides = Array.from(track.children) as HTMLElement[];
  const dots = Array.from(element.querySelectorAll<HTMLButtonElement>("[data-dot]"));
  const prev = element.querySelector<HTMLButtonElement>("[data-prev]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  if (slides.length < 2) return;
  element.classList.add("is-ready");

  let index = 0;
  const rtl = () => (getComputedStyle(track).direction === "rtl" ? -1 : 1);
  const go = (target: number) => {
    index = (target + slides.length) % slides.length;
    track.scrollTo({ left: rtl() * index * track.clientWidth, behavior: "smooth" });
    mark();
  };
  const mark = () => dots.forEach((dot, at) => (at === index ? dot.setAttribute("aria-current", "true") : dot.removeAttribute("aria-current")));
  const onScroll = () => {
    const at = Math.round(Math.abs(track.scrollLeft) / Math.max(1, track.clientWidth));
    if (at !== index) {
      index = Math.min(slides.length - 1, at);
      mark();
    }
  };

  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    if (props.autoplay && !still && !paused && !document.hidden) timer = setInterval(() => go(index + 1), Math.max(3, props.interval) * 1000);
  };
  const pause = () => { paused = true; stop(); };
  const resume = () => { paused = false; start(); };

  const onPrev = () => { go(index - 1); start(); };
  const onNext = () => { go(index + 1); start(); };
  const onDot = (event: Event) => {
    const value = Number((event.currentTarget as HTMLElement).dataset.dot);
    if (Number.isInteger(value)) { go(value); start(); }
  };
  prev?.addEventListener("click", onPrev);
  next?.addEventListener("click", onNext);
  dots.forEach((dot) => dot.addEventListener("click", onDot));
  track.addEventListener("scroll", onScroll, { passive: true });
  element.addEventListener("pointerenter", pause);
  element.addEventListener("pointerleave", resume);
  element.addEventListener("focusin", pause);
  element.addEventListener("focusout", resume);
  document.addEventListener("visibilitychange", start);
  start();

  return () => {
    stop();
    prev?.removeEventListener("click", onPrev);
    next?.removeEventListener("click", onNext);
    dots.forEach((dot) => dot.removeEventListener("click", onDot));
    track.removeEventListener("scroll", onScroll);
    element.removeEventListener("pointerenter", pause);
    element.removeEventListener("pointerleave", resume);
    element.removeEventListener("focusin", pause);
    element.removeEventListener("focusout", resume);
    document.removeEventListener("visibilitychange", start);
  };
});
