// The header search's department select: the chosen department's listing
// receives the query (its own search within the listing), "All" searches
// the store. The form works without this island and then searches the
// whole store.

import { defineIsland } from "@scalius/plugin-sdk/island";

export default defineIsland((element) => {
  const form = element.querySelector<HTMLFormElement>("form");
  const select = element.querySelector<HTMLSelectElement>("[data-department]");
  if (!form || !select) return;
  const storeSearch = form.getAttribute("action") ?? "/search";
  const sync = () => {
    const value = select.value;
    // Only same-store paths: the options are the store's own category links.
    form.action = value.startsWith("/") && !value.startsWith("//") ? value : storeSearch;
    // Size the select to the chosen label, as the marketplace does.
    select.style.width = `${Math.min(14, Math.max(3, (select.selectedOptions[0]?.text.length ?? 3) + 2))}ch`;
  };
  select.addEventListener("change", sync);
  sync();
  return () => select.removeEventListener("change", sync);
});
