// src/server/openapi/collection-paths.ts
export const collectionPaths = {
  "/collections": {
    get: {
      tags: ["Collections"],
      summary: "List all active collections",
      description:
        "Returns a list of all active collections with their configuration. This endpoint is used to fetch the structure of homepage sections, like product carousels or grids. Collections now support multiple categories and flexible product selection.",
      responses: {
        "200": {
          description: "Successfully retrieved collections",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  collections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "coll_-8Q6s6Fq0X0zDWs6hn8Hn",
                        },
                        name: {
                          type: "string",
                          example: "Homepage Featured",
                        },
                        type: {
                          type: "string",
                          enum: ["collection1", "collection2"],
                          description: "UI rendering style only. collection1 = grid with featured product, collection2 = horizontal scroll",
                          example: "collection1",
                        },
                        config: {
                          type: "object",
                          description:
                            "JSON object defining the collection's behavior and product selection",
                          properties: {
                            categoryIds: {
                              type: "array",
                              items: { type: "string" },
                              description: "Array of category IDs to pull products from",
                              example: ["cat_123", "cat_456"],
                            },
                            productIds: {
                              type: "array",
                              items: { type: "string" },
                              description: "Array of specific product IDs to include",
                              example: ["prod_abc", "prod_xyz"],
                            },
                            featuredProductId: {
                              type: "string",
                              nullable: true,
                              description: "Optional featured product for collection1 style",
                              example: "prod_featured",
                            },
                            maxProducts: {
                              type: "number",
                              description: "Maximum number of products to display (1-24)",
                              example: 8,
                            },
                            title: {
                              type: "string",
                              nullable: true,
                              description: "Custom display title",
                              example: "Summer Collection",
                            },
                            subtitle: {
                              type: "string",
                              nullable: true,
                              description: "Custom display subtitle",
                              example: "Hot deals for the season",
                            },
                          },
                        },
                        sortOrder: {
                          type: "integer",
                          example: 1,
                        },
                        isActive: {
                          type: "boolean",
                          example: true,
                        },
                        createdAt: {
                          type: "string",
                          format: "date-time",
                          example: "2025-12-24T18:05:18.000Z",
                        },
                        updatedAt: {
                          type: "string",
                          format: "date-time",
                          example: "2025-12-24T18:05:18.000Z",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "Server error",
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
  "/collections/{id}": {
    get: {
      tags: ["Collections"],
      summary: "Get collection by ID",
      description:
        "Returns detailed information about a specific collection by its ID, including associated categories (array) and products. Collections can now pull from multiple categories and/or specific products.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "ID of the collection to retrieve.",
          schema: {
            type: "string",
            example: "coll_-8Q6s6Fq0X0zDWs6hn8Hn",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved collection",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: {
                    type: "boolean",
                    example: true,
                  },
                  collection: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        example: "coll_-8Q6s6Fq0X0zDWs6hn8Hn",
                      },
                      name: {
                        type: "string",
                        example: "Homepage Featured",
                      },
                      type: {
                        type: "string",
                        enum: ["collection1", "collection2"],
                        description: "UI rendering style only",
                        example: "collection1",
                      },
                      config: {
                        type: "object",
                        properties: {
                          categoryIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "Category IDs this collection pulls from",
                            example: ["cat_123", "cat_456"],
                          },
                          productIds: {
                            type: "array",
                            items: { type: "string" },
                            description: "Specific product IDs included",
                            example: ["prod_abc"],
                          },
                          featuredProductId: {
                            type: "string",
                            nullable: true,
                            example: "prod_featured",
                          },
                          maxProducts: {
                            type: "number",
                            example: 8,
                          },
                          title: {
                            type: "string",
                            nullable: true,
                            example: "Summer Sale",
                          },
                          subtitle: {
                            type: "string",
                            nullable: true,
                            example: "Best deals of the season",
                          },
                        },
                      },
                      sortOrder: {
                        type: "integer",
                        example: 1,
                      },
                      isActive: {
                        type: "boolean",
                        example: true,
                      },
                      createdAt: {
                        type: "string",
                        format: "date-time",
                        example: "2025-12-24T18:05:18.000Z",
                      },
                      updatedAt: {
                        type: "string",
                        format: "date-time",
                        example: "2025-12-24T18:05:18.000Z",
                      },
                      deletedAt: {
                        type: "string",
                        nullable: true,
                        format: "date-time",
                        example: null,
                      },
                      categories: {
                        type: "array",
                        description:
                          "CHANGED: Now an array of category objects (was single 'category' object)",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", example: "cat_123" },
                            name: { type: "string", example: "Tech Gadgets" },
                            slug: { type: "string", example: "tech-gadgets" },
                          },
                        },
                        example: [
                          {
                            id: "cat_123",
                            name: "Tech Gadgets",
                            slug: "tech-gadgets",
                          },
                          {
                            id: "cat_456",
                            name: "Smart Watches",
                            slug: "smart-watches",
                          },
                        ],
                      },
                      products: {
                        type: "array",
                        description: "Products in this collection (from categories and/or specific products)",
                        items: {
                          type: "object",
                          properties: {
                            id: {
                              type: "string",
                              example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                            },
                            name: {
                              type: "string",
                              example:
                                "Amazfit Bip 5 Unity Bluetooth Calling Smart Watch",
                            },
                            price: { type: "number", example: 5600 },
                            slug: { type: "string", example: "amazfit-bip-5" },
                            discountPercentage: {
                              type: "number",
                              nullable: true,
                              example: 7,
                            },
                            imageUrl: {
                              type: "string",
                              nullable: true,
                              example:
                                "https://cdn.scalius.com/Nur_AVLkaIoEeFCRphKhq.png",
                            },
                            discountedPrice: { type: "number", example: 5208 },
                          },
                        },
                      },
                      featuredProduct: {
                        type: "object",
                        nullable: true,
                        description:
                          "Featured product for collection1 style (optional)",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          price: { type: "number" },
                          discountPercentage: { type: "number", nullable: true },
                          slug: { type: "string" },
                          imageUrl: { type: "string", nullable: true },
                          discountedPrice: { type: "number" },
                        },
                        example: {
                          id: "prod_featured",
                          name: "Featured Smartwatch",
                          price: 9999,
                          discountPercentage: 10,
                          slug: "featured-smartwatch",
                          imageUrl: "https://cdn.scalius.com/featured.png",
                          discountedPrice: 8999,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Collection not found",
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
