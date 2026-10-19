import type { APIRoute } from "astro";
import { handleUcpRestRequest, ucpOptionsResponse } from "@/lib/ucp/catalog";

export const prerender = false;

export const OPTIONS: APIRoute = async () => ucpOptionsResponse();

export const POST: APIRoute = async ({ request }) => handleUcpRestRequest(request, "product");
