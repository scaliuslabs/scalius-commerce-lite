import type { APIRoute } from "astro";

import {
  redeemThemePreviewContinuation,
  themePreviewMethodNotAllowed,
  themePreviewRelayResponse,
} from "@/lib/theme-preview-continuation";

export const prerender = false;

// The theme editor's frame: the relay answers only its parent (the dashboard
// origin, which alone may frame it), sets a partitioned preview cookie the
// frame can carry, and lands on the page itself.
export const GET: APIRoute = async () => themePreviewRelayResponse("embed");

export const POST: APIRoute = async ({ request, url }) => redeemThemePreviewContinuation(request, url, "embed");

export const ALL: APIRoute = async () => themePreviewMethodNotAllowed();
