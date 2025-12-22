import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { createProvider } from "@/lib/delivery/factory";

// Initialize the service
const deliveryService = new DeliveryService();

export const GET: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
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

    const provider = await deliveryService.getProvider(id);

    if (!provider) {
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify(provider), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching provider:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch provider",
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

export const POST: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
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

    // Get the provider from database
    const provider = await deliveryService.getProvider(id);

    if (!provider) {
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // Create provider instance
    try {
      const providerInstance = createProvider(provider);

      // Test connection
      const result = await providerInstance.testConnection();

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (testError) {
      return new Response(
        JSON.stringify({
          success: false,
          message:
            testError instanceof Error
              ? testError.message
              : "Failed to test provider connection",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
  } catch (error) {
    console.error("Error testing provider:", error);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Internal server error",
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
