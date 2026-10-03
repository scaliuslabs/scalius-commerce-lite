import { useState } from "react";

/**
 * True from the first render where `open` is true on. A dialog loaded on
 * demand mounts when it first opens and stays mounted, so it animates closed.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
