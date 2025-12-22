import type { APIRoute } from "astro";
import { FraudCheckerService } from "@/lib/fraud-checker/service";

const fraudCheckerService = new FraudCheckerService();

export const POST: APIRoute = async ({ request }) => {
  try {
    const { phone } = await request.json();

    if (!phone) {
      return new Response(
        JSON.stringify({ error: "Phone number is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const result = await fraudCheckerService.lookupWithActiveProvider(phone);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error performing fraud lookup:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Lookup failed",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};
