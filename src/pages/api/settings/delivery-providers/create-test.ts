import type { APIRoute } from "astro";
import { createProvider } from "@/lib/delivery/factory";
import { nanoid } from "nanoid";
import { safeErrorResponse } from "@/lib/error-utils";

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log("Testing delivery provider with direct credentials");

    // Get request body
    const data = await request.json();
    const { type, credentials, config, name = "Test Provider" } = data;

    // Validate required fields
    if (!type) {
      return new Response(
        JSON.stringify({ error: "Provider type is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (!credentials) {
      return new Response(
        JSON.stringify({ error: "Provider credentials are required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (!config) {
      return new Response(
        JSON.stringify({ error: "Provider config is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    console.log(`Testing ${type} provider with direct credentials`);

    // Create a mock provider object
    const mockProvider = {
      id: nanoid(),
      name,
      type,
      isActive: true,
      credentials:
        typeof credentials === "string"
          ? credentials
          : JSON.stringify(credentials),
      config: typeof config === "string" ? config : JSON.stringify(config),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      // Create provider instance
      const providerInstance = createProvider(mockProvider);
      console.log(`Created test provider instance successfully`);

      // Test connection
      const result = await providerInstance.testConnection();
      console.log(
        `Test result: ${result.success ? "Success" : "Failed"} - ${result.message}`,
      );

      return new Response(
        JSON.stringify({
          ...result,
          provider: {
            type,
            name,
            // Only return a summary of the credentials for security
            credentials: "...",
            config: "...",
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    } catch (testError) {
      console.error(
        "Error testing provider with direct credentials:",
        testError,
      );
      return new Response(
        JSON.stringify({
          success: false,
          message:
            testError instanceof Error
              ? testError.message
              : "Failed to test provider connection",
        }),
        {
          status: 200, // Still sending 200 but with success: false
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
