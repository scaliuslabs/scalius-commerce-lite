import { createRoot } from "react-dom/client";
import CartFlyout from "@/components/CartFlyout";

let ready: Promise<void> | null = null;

export function mountCartFlyout(): Promise<void> {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const root = document.createElement("div");
    root.dataset.lazyUi = "cart-flyout";
    document.body.append(root);
    createRoot(root).render(<CartFlyout onReady={resolve} />);
  });
  return ready;
}
