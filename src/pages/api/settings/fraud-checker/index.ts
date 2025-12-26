import type { APIRoute } from "astro";
import { FraudCheckerService } from "@/lib/fraud-checker/service";
import { safeErrorResponse } from "@/lib/error-utils";

const fraudCheckerService = new FraudCheckerService();

// SECURITY: Masked value for sensitive fields
const MASKED_VALUE = "••••••••••••";

export const GET: APIRoute = async () => {
  try {
    const providers = await fraudCheckerService.getProviders();

    // SECURITY: Mask API keys before sending to client
    const maskedProviders = providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? MASKED_VALUE : "",
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
    const provider = await request.json();

    if (!provider.name || !provider.apiUrl || !provider.apiKey) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: ["name", "apiUrl", "apiKey"],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const savedProvider = await fraudCheckerService.saveProvider(provider);

    // SECURITY: Mask API key in response
    const maskedResponse = {
      ...savedProvider,
      apiKey: savedProvider.apiKey ? MASKED_VALUE : "",
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
    const provider = await request.json();

    if (
      !provider.id ||
      !provider.name ||
      !provider.apiUrl ||
      !provider.apiKey
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: ["id", "name", "apiUrl", "apiKey"],
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // SECURITY: If API key is masked, fetch existing from database
    if (provider.apiKey === MASKED_VALUE) {
      const existingProvider = await fraudCheckerService.getProvider(
        provider.id,
      );
      if (existingProvider?.apiKey) {
        provider.apiKey = existingProvider.apiKey;
      }
    }

    const savedProvider = await fraudCheckerService.saveProvider(provider);

    // SECURITY: Mask API key in response
    const maskedResponse = {
      ...savedProvider,
      apiKey: savedProvider.apiKey ? MASKED_VALUE : "",
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
