// `/apps/<plugin id>/*`: installed apps' public routes on the store's own
// origin (lib/app-proxy.ts). Never cached here; the API decides the response's
// Cache-Control and only the apps that declare the proxy answer.
import type { APIRoute } from "astro";
import { proxyAppRequest } from "@/lib/app-proxy";

export const prerender = false;

export const ALL: APIRoute = ({ request, params }) =>
  proxyAppRequest(request, params.pluginId ?? "", params.path ?? "");
