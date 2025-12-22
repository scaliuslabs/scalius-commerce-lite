// src/server/openapi/openapi-config.ts
export const openapiConfig = {
  openapi: "3.0.0",
  info: {
    title: "Scalius Commerce API",
    version: "1.0.0",
    description:
      "API for the Scalius Commerce platform. This specification provides all the necessary details to build a complete e-commerce storefront, from displaying products and categories to processing orders and managing customer data.",
    contact: {
      name: "Scalius Support",
      url: "https://scalius.com/support",
    },
  },
  servers: [
    {
      url: "/api/v1",
      description: "API v1",
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "A short-lived JSON Web Token obtained from the /auth/token endpoint.",
      },
      apiToken: {
        type: "apiKey",
        in: "header",
        name: "X-API-Token",
        description:
          "A static, pre-shared token for machine-to-machine authentication to obtain a JWT.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          error: { type: "string", example: "Error Type" },
          message: { type: "string", example: "A detailed error message." },
        },
      },
      Success: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { type: "object" },
        },
      },
      OrderPostRequest: {
        type: "object",
        required: [
          "customerName",
          "customerPhone",
          "shippingAddress",
          "city",
          "zone",
          "items",
          "shippingCharge",
        ],
        properties: {
          customerName: { type: "string", minLength: 3, maxLength: 100 },
          customerPhone: { type: "string", pattern: "^(\+88)?01[3-9]\d{8}$" },
          customerEmail: { type: "string", format: "email", nullable: true },
          shippingAddress: { type: "string", minLength: 10, maxLength: 500 },
          city: {
            type: "string",
            description: "City ID from /locations/cities.",
          },
          zone: {
            type: "string",
            description: "Zone ID from /locations/zones.",
          },
          area: {
            type: "string",
            nullable: true,
            description: "Area ID from /locations/areas (optional).",
          },
          cityName: {
            type: "string",
            nullable: true,
            description:
              "Name of the city (for record-keeping). Optional, as it can be looked up from the city ID, but providing it can be a useful fallback.",
          },
          zoneName: {
            type: "string",
            nullable: true,
            description:
              "Name of the zone (for record-keeping). Optional, can be looked up from zone ID.",
          },
          areaName: {
            type: "string",
            nullable: true,
            description:
              "Name of the area (for record-keeping). Optional, can be looked up from area ID.",
          },
          notes: { type: "string", maxLength: 500, nullable: true },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["productId", "quantity", "price"],
              properties: {
                productId: { type: "string" },
                variantId: { type: "string", nullable: true },
                quantity: { type: "integer", minimum: 1 },
                price: {
                  type: "number",
                  minimum: 0,
                  description:
                    "The final price per unit for this item, after any product-level discounts but before order-level discounts.",
                },
              },
            },
          },
          discountAmount: {
            type: "number",
            minimum: 0,
            nullable: true,
            description: "The total amount of discount applied to the order.",
          },
          discountCode: {
            type: "string",
            nullable: true,
            description:
              "The discount code used, if any. This is used for logging usage.",
          },
          shippingCharge: { type: "number", minimum: 0 },
          totalAmount: {
            type: "number",
            nullable: true,
            description:
              "The final total amount of the order. If not provided, it will be calculated on the server as: (items total) + shippingCharge - discountAmount.",
          },
        },
      },
    },
  },
  tags: [
    { name: "Auth", description: "Authentication and authorization." },
    { name: "System", description: "Endpoints for system health and status." },
    {
      name: "Products",
      description: "Endpoints for retrieving product information.",
    },
    { name: "Categories", description: "Endpoints for product categories." },
    {
      name: "Collections",
      description: "Endpoints for managing homepage content collections.",
    },
    {
      name: "Attributes",
      description: "Endpoints for retrieving filterable product attributes.",
    },
    { name: "Search", description: "Endpoints for site-wide search." },
    {
      name: "Orders",
      description: "Endpoints for creating and managing orders.",
    },
    {
      name: "Shipping Methods",
      description:
        "Endpoints for retrieving available shipping options and fees.",
    },
    {
      name: "Locations",
      description: "Endpoints for delivery locations (cities, zones, areas).",
    },
    {
      name: "Discounts",
      description: "Endpoints for validating and applying discounts.",
    },
    {
      name: "Storefront Content",
      description:
        "Endpoints for retrieving general storefront content like navigations, footers, etc.",
    },
    {
      name: "Hero",
      description: "Endpoints for managing homepage hero sections.",
    },
    {
      name: "Header",
      description: "Endpoints for retrieving header configuration.",
    },
    {
      name: "Footer",
      description: "Endpoints for retrieving footer configuration.",
    },
    {
      name: "Navigation",
      description: "Endpoints for retrieving navigation menus.",
    },
    { name: "Pages", description: "Endpoints for retrieving CMS pages." },
    {
      name: "Widgets",
      description: "Endpoints for dynamic, user-generated content widgets.",
    },
    {
      name: "Checkout Languages",
      description: "Endpoints for checkout page localization.",
    },
    { name: "SEO", description: "Endpoints for global SEO configuration." },
    {
      name: "Analytics",
      description: "Endpoints for third-party analytics configurations.",
    },
    {
      name: "Meta Conversions API",
      description: "Endpoints for server-side event tracking with Meta.",
    },
    {
      name: "Cache Management",
      description: "Endpoints for managing the API cache.",
    },
  ],
};
