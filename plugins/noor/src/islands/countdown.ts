// Counts down to an offer's end (epoch ms from the server), once a second,
// and stops at zero. Before it mounts the boxes read "--".

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ end?: number }>((element, props) => {
  const end = Number(props?.end);
  if (!Number.isFinite(end)) return;
  const values = new Map([...element.querySelectorAll<HTMLElement>("[data-unit]")].map((node) => [node.dataset.unit!, node]));
  const pad = (value: number) => String(value).padStart(2, "0");
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const seconds = Math.floor(left / 1000);
    values.get("days")!.textContent = pad(Math.floor(seconds / 86_400));
    values.get("hours")!.textContent = pad(Math.floor(seconds / 3_600) % 24);
    values.get("minutes")!.textContent = pad(Math.floor(seconds / 60) % 60);
    values.get("seconds")!.textContent = pad(seconds % 60);
    if (left === 0) {
      element.setAttribute("data-ended", "");
      if (timer) clearInterval(timer);
    }
  };
  if (!["days", "hours", "minutes", "seconds"].every((unit) => values.has(unit))) return;
  tick();
  timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
});
