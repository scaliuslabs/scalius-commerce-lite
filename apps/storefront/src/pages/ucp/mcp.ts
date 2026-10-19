import type { APIRoute } from "astro";
import { ucpOptionsResponse } from "@/lib/ucp/catalog";
import { handleUcpMcpRequest, ucpMcpMethodNotAllowed } from "@/lib/ucp/mcp";

export const prerender = false;

export const OPTIONS: APIRoute = async () => ucpOptionsResponse();

export const GET: APIRoute = async () => ucpMcpMethodNotAllowed();

export const POST: APIRoute = async ({ request }) => handleUcpMcpRequest(request);
