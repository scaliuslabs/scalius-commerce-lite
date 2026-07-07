import type { APIRoute } from "astro";
import {
  buildUcpProfile,
  getUcpBaseUrl,
  ucpJsonResponse,
  ucpOptionsResponse,
  ucpProfileUnavailableResponse,
} from "@/lib/ucp/catalog";

export const prerender = false;

export const OPTIONS: APIRoute = async () => ucpOptionsResponse();

export const GET: APIRoute = async () => {
  try {
    return ucpJsonResponse(buildUcpProfile(getUcpBaseUrl()));
  } catch {
    return ucpProfileUnavailableResponse();
  }
};
