// src/server/openapi/meta-conversions-paths.ts

const eventSchema = {
  type: "object",
  required: ["eventName", "eventSourceUrl", "userData"],
  properties: {
    eventName: {
      type: "string",
      description:
        "A standard or custom event name (e.g., 'Purchase', 'ViewContent').",
      example: "Purchase",
    },
    eventSourceUrl: {
      type: "string",
      description: "The URL of the page where the event occurred.",
      example: "https://yourstore.com/products/cool-widget",
    },
    actionSource: {
      type: "string",
      description:
        "Where the conversion occurred. Defaults to 'website' if not provided.",
      enum: [
        "website",
        "app",
        "offline",
        "chat",
        "physical_store",
        "system_generated",
        "business_messaging",
        "other",
      ],
      default: "website",
      example: "website",
    },
    userData: {
      type: "object",
      description:
        "User identification data. Provide as many fields as possible to improve Event Match Quality. PII (like email, phone, name) will be hashed by the server automatically according to Meta's requirements.",
      required: [],
      properties: {
        em: {
          type: "string",
          description: "User's email address (unhashed).",
          example: "test@example.com",
        },
        ph: {
          type: "string",
          description:
            "User's phone number (unhashed). Should include country code if possible.",
          example: "15551234567",
        },
        fn: {
          type: "string",
          description: "User's first name (unhashed).",
          example: "john",
        },
        ln: {
          type: "string",
          description: "User's last name (unhashed).",
          example: "smith",
        },
        ge: {
          type: "string",
          description: "User's gender. 'f' for female or 'm' for male.",
          enum: ["f", "m"],
          example: "m",
        },
        db: {
          type: "string",
          description: "User's date of birth in YYYYMMDD format.",
          example: "19901020",
        },
        ct: {
          type: "string",
          description: "User's city (unhashed).",
          example: "menlo park",
        },
        st: {
          type: "string",
          description: "User's state (unhashed). 2-letter ANSI code for US.",
          example: "ca",
        },
        zp: {
          type: "string",
          description: "User's zip code.",
          example: "94025",
        },
        country: {
          type: "string",
          description: "User's country. 2-letter ISO 3166-1 alpha-2 code.",
          example: "us",
        },
        external_id: {
          type: "string",
          description: "A unique ID from your system for the user.",
          example: "user12345",
        },
        client_ip_address: {
          type: "string",
          description: "User's IP address.",
          example: "123.123.123.123",
        },
        client_user_agent: {
          type: "string",
          description: "User's browser user agent string.",
          example:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        },
        fbp: {
          type: "string",
          description: "The Facebook browser ID (_fbp cookie).",
          example: "fb.1.1558571054389.1098115397",
        },
        fbc: {
          type: "string",
          description:
            "The Facebook click ID (_fbc cookie). Generated from fbclid URL parameter.",
          example: "fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
        },
        subscription_id: {
          type: "string",
          description: "The subscription ID for the user in a transaction.",
          example: "sub_1a2b3c",
        },
        lead_id: {
          type: "number",
          description: "The ID associated with a lead generated from a Meta Lead Ad.",
          example: 123456789012345,
        },
      },
    },
    customData: {
      type: "object",
      description: "Event-specific data like value, currency, or contents.",
      properties: {
        value: {
          type: "number",
          description: "Monetary value of the event.",
          example: 99.99,
        },
        currency: {
          type: "string",
          description: "ISO 4217 currency code.",
          example: "USD",
        },
        content_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of product SKUs or IDs.",
          example: ["PROD123", "PROD456"],
        },
        contents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              quantity: { type: "number" },
              item_price: { type: "number" },
            },
          },
          description: "Detailed information about products in the event.",
          example: [
            { id: "PROD123", quantity: 1, item_price: 49.99 },
            { id: "PROD456", quantity: 2, item_price: 25.0 },
          ],
        },
        content_type: {
          type: "string",
          enum: ["product", "product_group"],
          example: "product",
        },
        order_id: {
          type: "string",
          description:
            "The order or transaction ID. Important for purchase events.",
          example: "ORDER54321",
        },
        search_string: {
          type: "string",
          description: "The user's search query.",
          example: "blue shoes",
        },
      },
    },
  },
};

export const metaConversionsPaths = {
  "/meta/events": {
    post: {
      tags: ["Meta Conversions API"],
      summary: "Send a server-side event to Meta",
      description:
        "Sends a single event to the Meta Conversions API. This endpoint is intended to be called from the storefront. The server handles fetching credentials, hashing PII data (like email and name) according to Meta's requirements, and logging the request. Providing more user data fields will improve the Event Match Quality (EMQ) and can lead to better ad performance and attribution.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: eventSchema,
          },
        },
      },
      responses: {
        "200": {
          description: "Event successfully received and queued for processing.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: {
                    type: "string",
                    example: "Event received and is being processed.",
                  },
                  eventId: {
                    type: "string",
                    description:
                      "The unique ID assigned to this event for server-side deduplication.",
                    example: "cuid2_abcdefg12345",
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Bad Request - The provided payload was invalid.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "503": {
          description:
            "Service Unavailable - The Conversions API is not configured or enabled on the server.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
      },
    },
  },
};