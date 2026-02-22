import type { APIRoute } from "astro";
import { db } from "@/db";
import { siteSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

const MASKED_VALUE = "••••••••••••";

export const GET: APIRoute = async () => {
    try {
        const [settings] = await db.select().from(siteSettings).limit(1);

        if (!settings) {
            return new Response(JSON.stringify({ message: "Settings not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(
            JSON.stringify({
                authVerificationMethod: settings.authVerificationMethod,
                guestCheckoutEnabled: settings.guestCheckoutEnabled,
                whatsappAccessToken: settings.whatsappAccessToken ? MASKED_VALUE : "",
                whatsappPhoneNumberId: settings.whatsappPhoneNumberId || "",
                whatsappTemplateName: settings.whatsappTemplateName || "",
            }),
            {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }
        );
    } catch (error) {
        console.error("Error fetching auth settings:", error);
        return new Response(JSON.stringify({ message: "Error fetching auth settings" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json();
        const {
            authVerificationMethod,
            guestCheckoutEnabled,
            whatsappAccessToken,
            whatsappPhoneNumberId,
            whatsappTemplateName,
        } = body as {
            authVerificationMethod?: "email" | "phone" | "both";
            guestCheckoutEnabled?: boolean;
            whatsappAccessToken?: string;
            whatsappPhoneNumberId?: string;
            whatsappTemplateName?: string;
        };

        const [existingSettings] = await db.select().from(siteSettings).limit(1);

        if (!existingSettings) {
            return new Response(JSON.stringify({ message: "Base Site Settings must be configured first" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const updates: Partial<typeof siteSettings.$inferInsert> = {};

        if (authVerificationMethod) updates.authVerificationMethod = authVerificationMethod;
        if (guestCheckoutEnabled !== undefined) updates.guestCheckoutEnabled = guestCheckoutEnabled;
        if (whatsappPhoneNumberId !== undefined) updates.whatsappPhoneNumberId = whatsappPhoneNumberId;
        if (whatsappTemplateName !== undefined) updates.whatsappTemplateName = whatsappTemplateName;

        // Only update WhatsApp Token if it's not the masked value
        if (whatsappAccessToken && whatsappAccessToken !== MASKED_VALUE) {
            updates.whatsappAccessToken = whatsappAccessToken;
        }

        // Update the singular row
        await db
            .update(siteSettings)
            .set(updates)
            .where(eq(siteSettings.id, existingSettings.id));

        return new Response(
            JSON.stringify({ message: "Auth settings saved successfully" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Error saving auth settings:", error);
        return new Response(
            JSON.stringify({ message: "Error saving auth settings" }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
};
