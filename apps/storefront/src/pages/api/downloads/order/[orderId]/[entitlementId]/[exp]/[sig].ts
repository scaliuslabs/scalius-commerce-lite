// A guest order's download: streams the ticket's file with that order's
// receipt proof, read from its httpOnly cookie and sent to the API only as the
// X-Receipt-Token header. The URL carries ids and the ticket's expiry and
// signature; without the cookie it is a 404.
import type { APIRoute } from "astro";
import { isDigitalId, readTicketParams } from "@/lib/account-downloads";
import { proxyDownloadStream } from "@/lib/account-downloads-server";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const orderId = isDigitalId(params.orderId) ? params.orderId : "";
  return proxyDownloadStream(request, { kind: "receipt", orderId }, orderId ? readTicketParams(params) : null);
};
