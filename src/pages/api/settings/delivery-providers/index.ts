import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { safeErrorResponse } from "@/lib/error-utils";

// Initialize the service
const deliveryService = new DeliveryService();

// SECURITY: Constant for masked credentials
const MASKED_VALUE = "••••••••••••";

/**
 * SECURITY: Unmask credentials by fetching from database if fields are masked
 * This ensures masked credentials from the client are never saved to the database
 */
function unmaskedCredentials(
  newCredentials: string,
  existingCredentials?: string,
): string {
  try {
    const newCreds = JSON.parse(newCredentials);

    // If no existing credentials, use new ones as-is
    if (!existingCredentials) {
      return newCredentials;
    }

    const existingCreds = JSON.parse(existingCredentials);
    const unmasked = { ...newCreds };

    // Restore masked fields from existing credentials
    if (unmasked.clientSecret === MASKED_VALUE && existingCreds.clientSecret) {
      unmasked.clientSecret = existingCreds.clientSecret;
    }
    if (unmasked.password === MASKED_VALUE && existingCreds.password) {
      unmasked.password = existingCreds.password;
    }
    if (unmasked.apiKey === MASKED_VALUE && existingCreds.apiKey) {
      unmasked.apiKey = existingCreds.apiKey;
    }
    if (unmasked.secretKey === MASKED_VALUE && existingCreds.secretKey) {
      unmasked.secretKey = existingCreds.secretKey;
    }

    return JSON.stringify(unmasked);
  } catch (e) {
    // If parsing fails, return new credentials as-is
    return newCredentials;
  }
}

/**
 * SECURITY: Mask sensitive credentials before sending to client
 */
function maskCredentialsForClient(credentialsJson: string): string {
  try {
    const credentials = JSON.parse(credentialsJson);
    const masked = { ...credentials };

    // Mask all sensitive fields
    if (masked.clientSecret) masked.clientSecret = MASKED_VALUE;
    if (masked.password) masked.password = MASKED_VALUE;
    if (masked.apiKey) masked.apiKey = MASKED_VALUE;
    if (masked.secretKey) masked.secretKey = MASKED_VALUE;

    return JSON.stringify(masked);
  } catch (e) {
    return credentialsJson;
  }
}

export const GET: APIRoute = async () => {
  try {
    // Authentication is handled by middleware
    const providers = await deliveryService.getProviders();

    // SECURITY: Mask credentials before sending to client
    const maskedProviders = providers.map((provider) => ({
      ...provider,
      credentials: maskCredentialsForClient(provider.credentials),
    }));

    return new Response(JSON.stringify(maskedProviders), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  try {
    // Authentication is handled by middleware
    const provider = await request.json();

    // Validate required fields
    if (!provider.name || !provider.type) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: ["name", "type"],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Ensure credentials and config are strings
    if (typeof provider.credentials !== "string") {
      provider.credentials = JSON.stringify(provider.credentials);
    }

    if (typeof provider.config !== "string") {
      provider.config = JSON.stringify(provider.config);
    }

    // Save provider
    const savedProvider = await deliveryService.saveProvider(provider);

    // SECURITY: Mask credentials in response
    const maskedResponse = {
      ...savedProvider,
      credentials: maskCredentialsForClient(savedProvider.credentials),
    };

    return new Response(JSON.stringify(maskedResponse), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const PUT: APIRoute = async ({ request }) => {
  try {
    // Authentication is handled by middleware
    const provider = await request.json();
    console.log("Updating provider:", provider);

    // Validate required fields
    if (!provider.id || !provider.name || !provider.type) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: ["id", "name", "type"],
          received: provider,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Ensure credentials and config are strings
    if (provider.credentials && typeof provider.credentials !== "string") {
      provider.credentials = JSON.stringify(provider.credentials);
    }

    if (provider.config && typeof provider.config !== "string") {
      provider.config = JSON.stringify(provider.config);
    }

    // Check if provider exists
    const existingProvider = await deliveryService.getProvider(provider.id);
    if (!existingProvider) {
      console.log(`Provider not found: ${provider.id}`);
      // Create the provider if it doesn't exist
      const savedProvider = await deliveryService.saveProvider(provider);

      // SECURITY: Mask credentials in response
      const maskedResponse = {
        ...savedProvider,
        credentials: maskCredentialsForClient(savedProvider.credentials),
      };

      return new Response(JSON.stringify(maskedResponse), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // SECURITY: Unmask credentials before saving
    const unmaskedCreds = unmaskedCredentials(
      provider.credentials,
      existingProvider.credentials,
    );

    // Update existing provider
    const savedProvider = await deliveryService.saveProvider({
      ...provider,
      credentials: unmaskedCreds,
      // Explicitly include required fields
      id: provider.id,
      name: provider.name,
      type: provider.type,
      isActive:
        provider.isActive !== undefined
          ? provider.isActive
          : existingProvider.isActive,
    });

    // SECURITY: Mask credentials in response
    const maskedResponse = {
      ...savedProvider,
      credentials: maskCredentialsForClient(savedProvider.credentials),
    };

    return new Response(JSON.stringify(maskedResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
