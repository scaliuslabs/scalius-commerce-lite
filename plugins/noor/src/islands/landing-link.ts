import { defineIsland } from "@scalius/plugin-sdk/island";

// Keep the server's product/shop link unless the page really has an order
// form. A product hero must never jump to another product's form.
export default defineIsland<{ productId?: string }>((element, props) => {
  const link = element.querySelector<HTMLAnchorElement>("[data-noor-order-link]");
  if (!link) return;
  const fallback = link.getAttribute("href");
  const label = link.querySelector<HTMLElement>("[data-order-label-text]") ?? link;
  const fallbackLabel = label.textContent;
  const update = () => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(".noor-order[data-noor-order-product]"))
      .find((order) => (!props?.productId || order.dataset.noorOrderProduct === props.productId)
        && order.querySelector("form[data-order-form]") && order.closest(".noor-s-order[id]"))
      ?.closest<HTMLElement>(".noor-s-order[id]");
    link.hidden = !target && !fallback;
    if (target) link.setAttribute("href", `#${target.id}`);
    else if (fallback) link.setAttribute("href", fallback);
    else link.removeAttribute("href");
    if (link.dataset.orderLabel) label.textContent = target ? link.dataset.orderLabel : fallbackLabel;
  };
  const onClick = (event: MouseEvent) => {
    update();
    if (!link.hasAttribute("href")) event.preventDefault();
  };
  update();
  link.addEventListener("click", onClick);
  return () => link.removeEventListener("click", onClick);
});
