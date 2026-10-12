// Slideshows and quote rows: the track scrolls and snaps on its own; this
// adds previous and next, dots that follow the visible slide, arrow keys,
// and autoplay that yields to the buyer's controls and motion preference.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ autoplay?: boolean; interval?: number }>((element, props) => {
  const track = element.querySelector<HTMLElement>("[data-track]");
  const slides = track ? [...track.querySelectorAll<HTMLElement>("[data-slide]")] : [];
  if (!track || slides.length < 2) return;
  const controls = element.querySelector<HTMLElement>("[data-controls]");
  const dots = [...element.querySelectorAll<HTMLButtonElement>("[data-dot]")];
  controls?.removeAttribute("hidden");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let current = 0;
  const go = (index: number) => {
    const next = (index + slides.length) % slides.length;
    track.scrollTo({ left: slides[next]!.offsetLeft - slides[0]!.offsetLeft, behavior: motion.matches ? "auto" : "smooth" });
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
  const onPrev = () => { stop(); go(current - 1); };
  const onNext = () => { stop(); go(current + 1); };
  prev?.addEventListener("click", onPrev);
  next?.addEventListener("click", onNext);
  const onDot = (event: Event) => { stop(); go(Number((event.currentTarget as HTMLElement).dataset.dot)); };
  dots.forEach((dot) => dot.addEventListener("click", onDot));
  const onKey = (event: KeyboardEvent) => {
    const rtl = getComputedStyle(track).direction === "rtl";
    if (event.key === "ArrowRight") { event.preventDefault(); go(current + (rtl ? -1 : 1)); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(current + (rtl ? 1 : -1)); }
  };
  track.addEventListener("keydown", onKey);

  let timer: ReturnType<typeof setInterval> | undefined;
  let hovering = false;
  let focused = false;
  let stopped = !props?.autoplay || motion.matches;
  const toggle = element.querySelector<HTMLButtonElement>("[data-autoplay-toggle]");
  const updateToggle = () => {
    if (!toggle) return;
    toggle.setAttribute("aria-label", (stopped ? toggle.dataset.playLabel : toggle.dataset.pauseLabel) ?? "");
    toggle.querySelector<HTMLElement>("[data-pause-icon]")?.toggleAttribute("hidden", stopped);
    toggle.querySelector<HTMLElement>("[data-play-icon]")?.toggleAttribute("hidden", !stopped);
  };
  const stop = () => { stopped = true; updateToggle(); };
  const onIntent = (event: Event) => {
    if (event.target instanceof Node && toggle?.contains(event.target)) return;
    stop();
  };
  const onToggle = () => { stopped = !stopped; updateToggle(); };
  const onMotion = () => { if (motion.matches) stop(); };
  updateToggle();
  if (props?.autoplay) {
    const seconds = Math.max(3, Math.min(12, Number(props.interval) || 6));
    timer = setInterval(() => {
      if (!stopped && !hovering && !focused && document.visibilityState === "visible") go(current + 1);
    }, seconds * 1000);
  }
  const enter = () => { hovering = true; };
  const leave = () => { hovering = false; };
  const focus = () => { focused = true; };
  const blur = (event: FocusEvent) => { focused = event.relatedTarget instanceof Node && element.contains(event.relatedTarget); };
  element.addEventListener("pointerenter", enter);
  element.addEventListener("pointerleave", leave);
  element.addEventListener("focusin", focus);
  element.addEventListener("focusout", blur);
  element.addEventListener("pointerdown", onIntent);
  element.addEventListener("wheel", onIntent, { passive: true });
  element.addEventListener("keydown", onIntent);
  toggle?.addEventListener("click", onToggle);
  motion.addEventListener("change", onMotion);

  return () => {
    observer.disconnect();
    if (timer) clearInterval(timer);
    prev?.removeEventListener("click", onPrev);
    next?.removeEventListener("click", onNext);
    dots.forEach((dot) => dot.removeEventListener("click", onDot));
    track.removeEventListener("keydown", onKey);
    element.removeEventListener("pointerenter", enter);
    element.removeEventListener("pointerleave", leave);
    element.removeEventListener("focusin", focus);
    element.removeEventListener("focusout", blur);
    element.removeEventListener("pointerdown", onIntent);
    element.removeEventListener("wheel", onIntent);
    element.removeEventListener("keydown", onIntent);
    toggle?.removeEventListener("click", onToggle);
    motion.removeEventListener("change", onMotion);
  };
});
