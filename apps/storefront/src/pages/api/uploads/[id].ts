// The buyer takes back a file no order holds yet (lib/buyer-uploads/server.ts).
import type { APIRoute } from "astro";
import { proxyBuyerUploadRemove } from "@/lib/buyer-uploads/server";

export const prerender = false;

export const DELETE: APIRoute = ({ request, params }) => proxyBuyerUploadRemove(request, params.id);
