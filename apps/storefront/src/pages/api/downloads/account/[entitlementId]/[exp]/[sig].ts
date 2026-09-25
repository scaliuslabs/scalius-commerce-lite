// A signed-in buyer's download: streams the ticket's file with the account
// session (the `cs_tok` cookie only). The URL carries the entitlement id and
// the ticket's expiry and signature; without this browser's session it is a 404.
import type { APIRoute } from "astro";
import { readTicketParams } from "@/lib/account-downloads";
import { proxyDownloadStream } from "@/lib/account-downloads-server";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) =>
  proxyDownloadStream(request, { kind: "account" }, readTicketParams(params));
