// A buyer's file for an app's file input (lib/buyer-uploads/server.ts).
import type { APIRoute } from "astro";
import { proxyBuyerUpload } from "@/lib/buyer-uploads/server";

export const prerender = false;

export const POST: APIRoute = ({ request }) => proxyBuyerUpload(request);
