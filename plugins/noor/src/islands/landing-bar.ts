// One phone bar follows the next order form. Hide it while a form is on
// screen; without JavaScript the page's product links and forms still work.
import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ target?: string }>((element, props) => {
  const target = props?.target ? document.getElementById(props.target) : null;
  let frame = 0;
  const update = () => {
    frame = 0;
    const orders = Array.from(document.querySelectorAll<HTMLElement>(".noor-s-order"))
      .filter((order) => order.querySelector(".noor-bar") && order.querySelector("form[data-order-form]"))
      .map((order) => ({ order, bounds: order.getBoundingClientRect() }));
    const next = orders.find(({ bounds }) => bounds.bottom > 0) ?? orders.at(-1);
    const atForm = next && next.bounds.top < window.innerHeight * 0.85 && next.bounds.bottom > 0;
    const hidden = !next || next.order !== target || Boolean(atForm) || window.scrollY <= window.innerHeight * 0.7;
    element.toggleAttribute("data-hidden", hidden);
    element.inert = hidden;
    element.setAttribute("aria-hidden", String(hidden));
    element.setAttribute("data-ready", "");
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  update();
  return () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
});
