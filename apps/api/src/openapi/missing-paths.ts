export const missingPaths = {
  "/analytics/configurations": {
    get: {
      tags: ["Analytics"],
      summary: "Get active analytics configurations",
      description:
        "Returns a list of all active analytics and tracking scripts (e.g., Google Analytics, Facebook Pixel) configured for the storefront. The `config` property for each script is dynamically processed on the server to be ready for injection, especially for scripts that use Partytown.",
      responses: {
        "200": {
          description: "Successfully retrieved analytics configurations.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  analytics: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        type: {
                          type: "string",
                          description:
                            "e.g., 'google_analytics', 'facebook_pixel'",
                        },
                        config: {
                          type: "object",
                          description:
                            "The processed configuration or script content, ready for use.",
                        },
                        isActive: { type: "boolean" },
                        usePartytown: { type: "boolean" },
                        location: {
                          type: "string",
                          enum: ["head", "body_start", "body_end"],
                          description:
                            "The recommended location to inject the script in the HTML.",
                        },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          $ref: "#/components/schemas/Error",
        },
      },
    },
  },
  "/cache/stats": {
    get: {
      tags: ["Cache Management"],
      summary: "Get cache statistics",
      description:
        "Retrieves statistics about the API cache (Redis or in-memory fallback). This is useful for monitoring the health and performance of the caching layer. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Cache statistics retrieved successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  stats: {
                    type: "object",
                    properties: {
                      size: {
                        type: "number",
                        description: "Number of keys in the cache.",
                      },
                      memory: {
                        type: "string",
                        description: "Approximate memory usage.",
                      },
                      hitRate: { type: "string", nullable: true },
                      missRate: { type: "string", nullable: true },
                      uptime: {
                        type: "string",
                        description: "Cache server uptime.",
                      },
                      cacheType: { type: "string", enum: ["redis", "memory"] },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the entire API cache",
      description:
        "Invalidates the entire API cache for all resources. This is a powerful action that should be used with caution, for example, after a major deployment or data migration. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-products": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the product cache",
      description:
        "Invalidates all cached data related to products, including product lists (PLP) and individual product details (PDP). Use this after creating, updating, or deleting any product. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Product cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-categories": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the category cache",
      description:
        "Invalidates all cached data related to categories. Use this after creating, updating, or deleting any category. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Category cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-collections": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the collections cache",
      description:
        "Invalidates cached data for homepage collections (e.g., featured product carousels). Use this after changing collection settings. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Collections cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-footer": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the footer cache",
      description:
        "Invalidates cached data for the site footer. Use this after updating footer content or links. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Footer cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-header": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the header cache",
      description:
        "Invalidates cached data for the site header. Use this after updating header content or navigation. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Header cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-hero": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the hero section cache",
      description:
        "Invalidates cached data for the homepage hero section and sliders. Use this after updating hero content. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Hero cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-navigation": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the navigation cache",
      description:
        "Invalidates cached data for all navigation menus (header, footer, etc.). Use this after changing menu structures. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Navigation cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-pages": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the CMS pages cache",
      description:
        "Invalidates cached data for all static CMS pages. Use this after updating page content. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Pages cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/cache/clear-search": {
    post: {
      tags: ["Cache Management"],
      summary: "Clear the search cache",
      description:
        "Invalidates cached search results. This is useful if underlying product or page data has changed, but you don't want to clear the entire product/page cache. Requires admin authentication.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Search cache cleared successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
};
