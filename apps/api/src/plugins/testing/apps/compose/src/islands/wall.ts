// The wall island: mounts only once the deferred wall entered the page, and
// marks it ready (a stand-in for a heavy gallery's behaviour).

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland<{ rows: number }>((element, props) => {
  element.setAttribute("data-wall-ready", String(props.rows));
  return () => element.removeAttribute("data-wall-ready");
});
