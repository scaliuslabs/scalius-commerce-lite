import type { APIRoute } from "astro";
import { FraudCheckerService } from "@/lib/fraud-checker/service";

const fraudCheckerService = new FraudCheckerService();

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ error: "Provider ID is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    await fraudCheckerService.deleteProvider(id);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error deleting provider:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to delete provider",
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};
