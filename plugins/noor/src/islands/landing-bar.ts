// The order landing's phone bar: hidden while the order form is on screen
// (the buyer is already there), shown again when they scroll away.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ target?: string }>((element, props) => {
  const target = props?.target ? document.getElementById(props.target) : null;
  if (!target) return;
  const observer = new IntersectionObserver(([entry]) => {
    element.toggleAttribute("data-hidden", Boolean(entry?.isIntersecting));
  }, { rootMargin: "0px 0px -20% 0px" });
  observer.observe(target);
  return () => observer.disconnect();
});
