import { useEffect } from "react";
import { useLocation } from "@tanstack/react-router";
import { rememberOrderListHref } from "~/lib/order-list-return";

/** The order page's Back arrow returns to the list exactly as shown: tab, filters and page. */
export function useRememberOrderListHref() {
  const href = useLocation({ select: (location) => location.pathname + location.searchStr });
  useEffect(() => rememberOrderListHref(href), [href]);
}
