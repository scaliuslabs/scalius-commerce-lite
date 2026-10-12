import { defineIsland } from "@scalius/plugin-sdk/island";

// No autoplay attribute: a reduced-motion buyer must never get a moving
// frame before hydration. Native controls remain usable without JavaScript.
export default defineIsland((element) => {
  const video = element.querySelector<HTMLVideoElement>("video");
  if (!video) return;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!motion.matches) {
    video.muted = true;
    void video.play().catch(() => { /* The browser may require a tap on the native play control. */ });
  }
  const onMotion = () => { if (motion.matches) video.pause(); };
  motion.addEventListener("change", onMotion);
  return () => { motion.removeEventListener("change", onMotion); video.pause(); };
});
