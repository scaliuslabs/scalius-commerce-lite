import type { APIRoute } from "astro";

export const prerender = false;

/** Where the order history lives: the account page's Orders section. */
export const ACCOUNT_ORDERS_HREF = "/account#ordersHeading";

// Buyers (and breadcrumbs trimmed by hand from /account/orders/<id>) reach
// /account/orders; the list is part of /account, so send them there instead of
// a 404. Temporary, so a future dedicated page is not shadowed by a cached 301.
export const GET: APIRoute = () =>
  new Response(null, {
    status: 302,
    headers: {
      Location: ACCOUNT_ORDERS_HREF,
      "Cache-Control": "private, no-store",
    },
  });
