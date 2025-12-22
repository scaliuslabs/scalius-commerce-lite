export const categoryPaths = {
  "/categories": {
    get: {
      tags: ["Categories"],
      summary: "List all categories",
      description: "Returns a list of all categories",
      responses: {
        "200": {
          description: "Successfully retrieved categories",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  categories: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "cat_fj1ZspPwVuHyQVCGDC0jf",
                        },
                        name: {
                          type: "string",
                          example: "Tech Gadgets",
                        },
                        slug: {
                          type: "string",
                          example: "tech-gadgets",
                        },
                        description: {
                          type: "string",
                          example:
                            "🔌 From smart tools to must-have devices — tech that simplifies & empowers everyday life.",
                        },
                        imageUrl: {
                          type: "string",
                          nullable: true,
                          example: null,
                        },
                        createdAt: {
                          type: "string",
                          example: "+057378-04-03T14:00:00.000Z",
                        },
                        metaTitle: {
                          type: "string",
                          nullable: true,
                          example: "Cool Tech Gadgets Online – Smart Tools",
                        },
                        metaDescription: {
                          type: "string",
                          nullable: true,
                          example:
                            "Shop trending tech gadgets that make life easier & smarter. Functional, innovative & cool.",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/categories/{slug}": {
    get: {
      tags: ["Categories"],
      summary: "Get category by slug",
      description: "Returns detailed information about a specific category",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "Slug of the category to retrieve",
          schema: {
            type: "string",
            example: "tech-gadgets",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved category",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  category: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        example: "cat_fj1ZspPwVuHyQVCGDC0jf",
                      },
                      name: {
                        type: "string",
                        example: "Tech Gadgets",
                      },
                      slug: {
                        type: "string",
                        example: "tech-gadgets",
                      },
                      description: {
                        type: "string",
                        example:
                          "🔌 From smart tools to must-have devices — tech that simplifies & empowers everyday life.",
                      },
                      imageUrl: {
                        type: "string",
                        nullable: true,
                        example: null,
                      },
                      createdAt: {
                        type: "string",
                        example: "+057378-04-03T14:00:00.000Z",
                      },
                      metaTitle: {
                        type: "string",
                        nullable: true,
                        example: "Cool Tech Gadgets Online – Smart Tools",
                      },
                      metaDescription: {
                        type: "string",
                        nullable: true,
                        example:
                          "Shop trending tech gadgets that make life easier & smarter. Functional, innovative & cool.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Category not found",
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
  "/categories/{slug}/products": {
    get: {
      tags: ["Categories"],
      summary: "Get products in a category with filtering",
      description:
        "Returns paginated products in a category with support for attribute filtering, search, price range, and sorting. Supports dynamic attribute filtering by passing attribute slugs as query parameters.",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "Slug of the category",
          schema: {
            type: "string",
            example: "smartphones",
          },
        },
        {
          name: "page",
          in: "query",
          required: false,
          description: "Page number for pagination",
          schema: {
            type: "integer",
            default: 1,
            minimum: 1,
          },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description: "Number of products per page",
          schema: {
            type: "integer",
            default: 20,
            minimum: 1,
            maximum: 100,
          },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          description: "Sort order for products",
          schema: {
            type: "string",
            enum: [
              "newest",
              "price-asc",
              "price-desc",
              "name-asc",
              "name-desc",
              "discount",
            ],
            default: "newest",
          },
        },
        {
          name: "search",
          in: "query",
          required: false,
          description: "Search term to filter products by name",
          schema: {
            type: "string",
          },
        },
        {
          name: "minPrice",
          in: "query",
          required: false,
          description: "Minimum price filter",
          schema: {
            type: "number",
            minimum: 0,
          },
        },
        {
          name: "maxPrice",
          in: "query",
          required: false,
          description: "Maximum price filter",
          schema: {
            type: "number",
            minimum: 0,
          },
        },
        {
          name: "freeDelivery",
          in: "query",
          required: false,
          description: "Filter by free delivery availability",
          schema: {
            type: "string",
            enum: ["true", "false"],
          },
        },
        {
          name: "hasDiscount",
          in: "query",
          required: false,
          description: "Filter by discount availability",
          schema: {
            type: "string",
            enum: ["true", "false"],
          },
        },
        {
          name: "samsung",
          in: "query",
          required: false,
          description:
            "Example: Filter by Samsung attribute value (dynamic attribute filtering)",
          schema: {
            type: "string",
            example: "S Series",
          },
        },
        {
          name: "warranty",
          in: "query",
          required: false,
          description:
            "Example: Filter by warranty attribute value (dynamic attribute filtering)",
          schema: {
            type: "string",
            example: "2 Year",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved category products",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  category: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      slug: { type: "string" },
                      description: { type: "string" },
                      imageUrl: { type: "string", nullable: true },
                      metaTitle: { type: "string", nullable: true },
                      metaDescription: { type: "string", nullable: true },
                    },
                  },
                  products: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        price: { type: "number" },
                        slug: { type: "string" },
                        discountPercentage: { type: "number", nullable: true },
                        freeDelivery: { type: "boolean" },
                        imageUrl: { type: "string", nullable: true },
                        discountedPrice: { type: "number" },
                        createdAt: { type: "string", nullable: true },
                        updatedAt: { type: "string", nullable: true },
                        category: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            slug: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                  pagination: {
                    type: "object",
                    properties: {
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      total: { type: "integer" },
                      totalPages: { type: "integer" },
                    },
                  },
                  appliedFilters: {
                    type: "object",
                    properties: {
                      attributes: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            slug: { type: "string" },
                            value: { type: "string" },
                          },
                        },
                      },
                      search: { type: "string", nullable: true },
                      minPrice: { type: "number", nullable: true },
                      maxPrice: { type: "number", nullable: true },
                      freeDelivery: { type: "string", nullable: true },
                      hasDiscount: { type: "string", nullable: true },
                      sort: { type: "string" },
                    },
                  },
                },
                example: {
                  category: {
                    id: "cat_123",
                    name: "Smartphones",
                    slug: "smartphones",
                    description: "Latest smartphones and mobile devices",
                  },
                  products: [
                    {
                      id: "prod_456",
                      name: "Samsung Galaxy S23",
                      price: 50000,
                      slug: "samsung-galaxy-s23",
                      discountPercentage: 10,
                      freeDelivery: true,
                      imageUrl: "https://example.com/image.jpg",
                      discountedPrice: 45000,
                    },
                  ],
                  pagination: {
                    page: 1,
                    limit: 20,
                    total: 1,
                    totalPages: 1,
                  },
                  appliedFilters: {
                    attributes: [
                      { slug: "samsung", value: "S Series" },
                      { slug: "warranty", value: "2 Year" },
                    ],
                    search: null,
                    minPrice: null,
                    maxPrice: null,
                    freeDelivery: null,
                    hasDiscount: null,
                    sort: "newest",
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Category not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
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
};
