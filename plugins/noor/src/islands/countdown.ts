// Counts down to an offer's end (epoch ms from the server), once a second,
// and stops at zero, in the page's digits (`zero`: the store's "0" on this
// page, "০" on a Bangla page). Before it mounts the boxes read "--".

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ end?: number; zero?: string }>((element, props) => {
  const end = Number(props?.end);
  if (!Number.isFinite(end)) return;
  const zero = typeof props?.zero === "string" && props.zero.length === 1 ? props.zero.codePointAt(0)! : 48;
  const values = new Map([...element.querySelectorAll<HTMLElement>("[data-unit]")].map((node) => [node.dataset.unit!, node]));
  const pad = (value: number) => String(value).padStart(2, "0").replace(/[0-9]/g, (digit) => String.fromCodePoint(zero + Number(digit)));
  /** Shows the time left; false once the offer has ended. */
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const seconds = Math.floor(left / 1000);
    values.get("days")!.textContent = pad(Math.floor(seconds / 86_400));
    values.get("hours")!.textContent = pad(Math.floor(seconds / 3_600) % 24);
    values.get("minutes")!.textContent = pad(Math.floor(seconds / 60) % 60);
    values.get("seconds")!.textContent = pad(seconds % 60);
    if (left > 0) return true;
    element.setAttribute("data-ended", "");
    return false;
  };
  if (!["days", "hours", "minutes", "seconds"].every((unit) => values.has(unit))) return;
  if (!tick()) return;
  const timer = setInterval(() => { if (!tick()) clearInterval(timer); }, 1000);
  return () => clearInterval(timer);
});
