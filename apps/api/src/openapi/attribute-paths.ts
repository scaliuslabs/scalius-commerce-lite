// src/server/openapi/attribute-paths.ts
export const attributePaths = {
  "/attributes/filterable": {
    get: {
      tags: ["Attributes"],
      summary: "Get filterable attributes and their values",
      description:
        "Returns a list of attributes that can be used for filtering products, along with all unique values for each attribute.",
      responses: {
        "200": {
          description: "Successfully retrieved filterable attributes.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        values: { type: "array", items: { type: "string" } },
                      },
                      example: {
                        id: "attr_123",
                        name: "Brand",
                        slug: "brand",
                        values: ["Samsung", "Apple", "Xiaomi"],
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
  "/attributes/category/{categoryId}": {
    get: {
      tags: ["Attributes"],
      summary: "Get filterable attributes for a specific category",
      description:
        "Returns all filterable attributes and their values that exist in products of the specified category.",
      parameters: [
        {
          name: "categoryId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "The ID of the category",
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved category attributes.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        values: { type: "array", items: { type: "string" } },
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
  "/attributes/category-slug/{categorySlug}": {
    get: {
      tags: ["Attributes"],
      summary: "Get filterable attributes for a category by slug",
      description:
        "Returns all filterable attributes and their values that exist in products of the specified category (identified by slug).",
      parameters: [
        {
          name: "categorySlug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "The slug of the category",
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved category attributes.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        values: { type: "array", items: { type: "string" } },
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
                type: "object",
                properties: {
                  error: { type: "string" },
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
  "/attributes/search-filters": {
    get: {
      tags: ["Attributes"],
      summary: "Get filterable attributes for search results",
      description:
        "Returns all filterable attributes and their values that exist in products matching the search query. Useful for showing filters on search result pages.",
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Search query to find matching products",
        },
        {
          name: "categoryId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Optional: Limit search to a specific category",
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved search filters.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filters: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        values: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
                example: {
                  filters: [
                    {
                      id: "attr_123",
                      name: "Brand",
                      slug: "brand",
                      values: ["Samsung", "Apple"],
                    },
                    {
                      id: "attr_456",
                      name: "Storage",
                      slug: "storage",
                      values: ["128GB", "256GB", "512GB"],
                    },
                  ],
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
};
