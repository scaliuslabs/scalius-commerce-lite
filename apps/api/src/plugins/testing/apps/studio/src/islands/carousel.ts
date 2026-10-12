// The carousel island: previous and next buttons for a scrolling row. The
// row scrolls (and snaps) without it; the buttons only appear once it mounts.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland((element, _props, context) => {
  const track = element.querySelector<HTMLElement>("[data-carousel-track]");
  if (!track) return;
  const label = (en: string, bn: string) => (context.language === "bn" ? bn : en);
  const controls = document.createElement("div");
  controls.className = "studio-carousel-controls";
  const button = (text: string, direction: -1 | 1) => {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = direction < 0 ? "‹" : "›";
    control.setAttribute("aria-label", text);
    control.addEventListener("click", () => track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: "smooth" }));
    return control;
  };
  controls.appendChild(button(label("Previous", "আগের"), -1));
  controls.appendChild(button(label("Next", "পরের"), 1));
  element.insertBefore(controls, element.firstChild);
  return () => controls.remove();
});
