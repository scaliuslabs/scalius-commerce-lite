import { Hono } from "hono";

const app = new Hono<{
    Variables: {
        db: any;
        user: any;
        session: any;
        env: any;
    };
}>();

const PROMPT_URLS = {
    widget: "https://text.wrygo.com/home-page-prompt.txt",
    "landing-page": "https://text.wrygo.com/pages-prompt.txt",
    collection: "https://text.wrygo.com/collection-prompt.txt",
};

// GET /api/v1/admin/prompts
app.get("/", async (c) => {
    const promptType = (c.req.query("type") || "widget") as keyof typeof PROMPT_URLS;
    const promptUrl = PROMPT_URLS[promptType] || PROMPT_URLS.widget;

    try {
        const response = await fetch(promptUrl, {
            method: "GET",
            headers: {
                Accept: "text/plain",
                "User-Agent": "Scalius-Commerce-Widget-System/1.0",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch system prompt from ${promptUrl}: ${response.status} ${response.statusText}`);
        }

        const systemPrompt = await response.text();

        if (!systemPrompt || systemPrompt.trim().length === 0) {
            throw new Error("System prompt is empty");
        }

        return c.text(systemPrompt, 200, {
            "Content-Type": "text/plain",
            "Cache-Control": "public, max-age=300", // Cache for 5 minutes
        });
    } catch (error: any) {
        console.error("Error fetching system prompt:", error);
        return c.json({
            error: "Failed to fetch system prompt",
            message: error.message || "Unknown error occurred",
        }, 500);
    }
});

export { app as adminAiPromptsRoutes };
