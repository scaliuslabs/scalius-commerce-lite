// src/pages/api/settings/email.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

const MASKED_VALUE = "••••••••••••";
const CATEGORY = "email";
const KEY_API_KEY = "resend_api_key";
const KEY_SENDER = "email_sender";

export const GET: APIRoute = async () => {
  try {
    const [apiKeyRow, senderRow] = await Promise.all([
      db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, KEY_API_KEY), eq(settings.category, CATEGORY)))
        .get(),
      db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, KEY_SENDER), eq(settings.category, CATEGORY)))
        .get(),
    ]);

    // SECURITY: Mask API key before sending to client
    const maskedApiKey = apiKeyRow?.value ? MASKED_VALUE : "";
    const sender = senderRow?.value || "";

    return new Response(JSON.stringify({ apiKey: maskedApiKey, sender }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching email settings:", error);
    return new Response(JSON.stringify({ message: "Error fetching email settings" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { apiKey, sender } = body as { apiKey?: string; sender?: string };

    const updates: Promise<void>[] = [];

    // Save API key (skip if masked value was echoed back)
    if (typeof apiKey === "string" && apiKey !== MASKED_VALUE) {
      updates.push(
        db
          .insert(settings)
          .values({
            id: `set_${nanoid(10)}`,
            key: KEY_API_KEY,
            value: apiKey,
            type: "string",
            category: CATEGORY,
          })
          .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value: apiKey },
          })
          .then(() => undefined),
      );
    }

    // Save sender email
    if (typeof sender === "string") {
      updates.push(
        db
          .insert(settings)
          .values({
            id: `set_${nanoid(10)}`,
            key: KEY_SENDER,
            value: sender,
            type: "string",
            category: CATEGORY,
          })
          .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value: sender },
          })
          .then(() => undefined),
      );
    }

    await Promise.all(updates);

    return new Response(
      JSON.stringify({ message: "Email settings saved successfully" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error saving email settings:", error);
    return new Response(
      JSON.stringify({ message: "Error saving email settings" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
