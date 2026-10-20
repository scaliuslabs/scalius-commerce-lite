// Product tabs: without this every tab's products show one after another
// under its own small heading; with it the tab row switches one panel at a
// time (the ARIA tabs pattern: click, arrow keys, Home and End).

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland((element) => {
  const tabs = Array.from(element.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const panels = Array.from(element.querySelectorAll<HTMLElement>("[data-panel]"));
  if (tabs.length < 2 || panels.length !== tabs.length) return;
  element.classList.add("is-ready");

  const select = (index: number, focus: boolean) => {
    tabs.forEach((tab, at) => {
      const on = at === index;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    panels.forEach((panel, at) => {
      if (at === index) panel.setAttribute("data-active", "");
      else panel.removeAttribute("data-active");
    });
  };
  const current = () => Math.max(0, tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true"));
  const onClick = (event: Event) => select(tabs.indexOf(event.currentTarget as HTMLButtonElement), false);
  const onKey = (event: KeyboardEvent) => {
    const rtl = getComputedStyle(element).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    const at = current();
    const target = event.key === forward ? at + 1 : event.key === backward ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    select((target + tabs.length) % tabs.length, true);
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", onClick);
    tab.addEventListener("keydown", onKey);
  });
  select(current(), false);

  return () => tabs.forEach((tab) => {
    tab.removeEventListener("click", onClick);
    tab.removeEventListener("keydown", onKey);
  });
});
