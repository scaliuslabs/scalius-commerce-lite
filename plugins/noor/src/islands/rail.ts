// Scrolling rows (products, quotes, tiles): the row scrolls and snaps on its
// own, with touch, trackpad and keyboard; this adds previous and next buttons
// on computers, shown only while the row overflows and disabled at its ends.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland((element) => {
  const track = element.querySelector<HTMLElement>("[data-track]");
  const nav = element.querySelector<HTMLElement>("[data-rail-nav]");
  const prev = element.querySelector<HTMLButtonElement>("[data-prev]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  if (!track || !nav || !prev || !next) return;

  let frame = 0;
  const update = () => {
    frame = 0;
    const max = track.scrollWidth - track.clientWidth;
    nav.hidden = max <= 4;
    // Logical start and end, so a right-to-left page works the same.
    const position = Math.abs(track.scrollLeft);
    prev.disabled = position <= 4;
    next.disabled = position >= max - 4;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const step = (direction: 1 | -1) => {
    const rtl = getComputedStyle(track).direction === "rtl" ? -1 : 1;
    track.scrollBy({ left: direction * rtl * Math.max(track.clientWidth * 0.85, 200), behavior: "smooth" });
  };
  const onPrev = () => step(-1);
  const onNext = () => step(1);
  prev.addEventListener("click", onPrev);
  next.addEventListener("click", onNext);
  track.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(track);
  update();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    resize.disconnect();
    prev.removeEventListener("click", onPrev);
    next.removeEventListener("click", onNext);
    track.removeEventListener("scroll", schedule);
  };
});
