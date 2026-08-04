import type { APIRoute } from "astro";
import { getUcpBaseUrl } from "@/lib/ucp/catalog";
import {
  llmsTxtResponse,
  llmsTxtUnavailableResponse,
} from "@/lib/llms-txt";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    return llmsTxtResponse(getUcpBaseUrl());
  } catch {
    return llmsTxtUnavailableResponse();
  }
};
