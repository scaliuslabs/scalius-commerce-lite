// The landing's phone order bar: it appears once the buyer has scrolled past
// the first screen (the hero has its own "Order now") and hides again while
// the order form is on screen (they are already there). Without script the
// bar simply stays.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ target?: string }>((element, props) => {
  const target = props?.target ? document.getElementById(props.target) : null;
  let atForm = false;
  let frame = 0;
  const update = () => {
    frame = 0;
    const pastHero = window.scrollY > window.innerHeight * 0.7;
    element.toggleAttribute("data-hidden", atForm || !pastHero);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const observer = target ? new IntersectionObserver(([entry]) => {
    atForm = Boolean(entry?.isIntersecting);
    schedule();
  }, { rootMargin: "0px 0px -15% 0px" }) : null;
  if (target) observer!.observe(target);
  window.addEventListener("scroll", schedule, { passive: true });
  update();
  return () => {
    observer?.disconnect();
    window.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
});
