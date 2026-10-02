import type { APIRoute } from "astro";

import {
  redeemThemePreviewContinuation,
  themePreviewMethodNotAllowed,
  themePreviewRelayResponse,
} from "@/lib/theme-preview-continuation";

export const prerender = false;

// A theme preview in a new tab: the relay answers its opener and lands on the preview canvas.
export const GET: APIRoute = async () => themePreviewRelayResponse("tab");

export const POST: APIRoute = async ({ request, url }) => redeemThemePreviewContinuation(request, url, "tab");

export const ALL: APIRoute = async () => themePreviewMethodNotAllowed();
