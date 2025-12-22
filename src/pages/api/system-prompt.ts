import type { APIRoute } from "astro";

// Define the URLs for different prompt types
const PROMPT_URLS = {
  widget: "https://text.wrygo.com/home-page-prompt.txt",
  "landing-page": "https://text.wrygo.com/pages-prompt.txt",
  collection: "https://text.wrygo.com/collection-prompt.txt",
};

export const GET: APIRoute = async ({ url }) => {
  const promptType = (url.searchParams.get("type") || "widget") as keyof typeof PROMPT_URLS;
  const promptUrl = PROMPT_URLS[promptType] || PROMPT_URLS.widget;

  try {
    // Fetch the system prompt from the external URL
    const response = await fetch(promptUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain",
        "User-Agent": "Scalius-Commerce-Widget-System/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch system prompt from ${promptUrl}: ${response.status} ${response.statusText}`,
      );
    }

    const systemPrompt = await response.text();

    if (!systemPrompt || systemPrompt.trim().length === 0) {
      throw new Error("System prompt is empty");
    }

    return new Response(systemPrompt, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error("Error fetching system prompt:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    return new Response(
      JSON.stringify({
        error: "Failed to fetch system prompt",
        message: errorMessage,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};