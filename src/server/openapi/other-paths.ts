export const otherPaths = {
  "/health": {
    get: {
      tags: ["System"],
      summary: "Health check",
      description: "Returns the health status of the API",
      responses: {
        "200": {
          description: "API is healthy",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                    example: "ok",
                  },
                  timestamp: {
                    type: "string",
                    format: "date-time",
                    example: "2025-06-30T18:30:26.054Z",
                  },
                  version: {
                    type: "string",
                    example: "0.0.1",
                  },
                  environment: {
                    type: "string",
                    example: "development",
                  },
                  uptime: {
                    type: "number",
                    example: 108537.029673125,
                  },
                  cache: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        example: "redis",
                      },
                      redisAvailable: {
                        type: "boolean",
                        example: true,
                      },
                      size: {
                        type: "number",
                        example: 24,
                      },
                      memory: {
                        type: "string",
                        example: "114.278KB",
                      },
                      hitRate: {
                        type: "string",
                        example: "68.91%",
                      },
                      missRate: {
                        type: "string",
                        example: "31.09%",
                      },
                      uptime: {
                        type: "string",
                        example: "0d 0h 0m 0s",
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
  "/hero/sliders": {
    get: {
      tags: ["Hero"],
      summary: "Get hero sliders",
      description:
        "Returns hero sliders based on device type or specific type requested",
      parameters: [
        {
          name: "type",
          in: "query",
          required: false,
          description: "Filter by slider type (desktop or mobile)",
          schema: {
            type: "string",
            enum: ["desktop", "mobile"],
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved hero sliders",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  desktop: {
                    type: "object",
                    nullable: true,
                    properties: {
                      id: { type: "string" },
                      type: { type: "string" },
                      images: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            url: { type: "string" },
                            alt: { type: "string" },
                            link: { type: "string", nullable: true },
                          },
                        },
                      },
                      isActive: { type: "boolean" },
                      createdAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                      updatedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                    },
                  },
                  mobile: {
                    type: "object",
                    nullable: true,
                    properties: {
                      id: { type: "string" },
                      type: { type: "string" },
                      images: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            url: { type: "string" },
                            alt: { type: "string" },
                            link: { type: "string", nullable: true },
                          },
                        },
                      },
                      isActive: { type: "boolean" },
                      createdAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                      updatedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                    },
                  },
                  images: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        url: { type: "string" },
                        alt: { type: "string" },
                        link: { type: "string", nullable: true },
                      },
                    },
                  },
                  isMobile: { type: "boolean" },
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
  "/hero/sliders/{id}": {
    get: {
      tags: ["Hero"],
      summary: "Get hero slider by ID",
      description: "Returns a specific hero slider by ID",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Slider ID",
          schema: {
            type: "string",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved hero slider",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  slider: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      type: { type: "string" },
                      images: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            url: { type: "string" },
                            alt: { type: "string" },
                            link: { type: "string", nullable: true },
                          },
                        },
                      },
                      isActive: { type: "boolean" },
                      createdAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                      updatedAt: {
                        type: "string",
                        format: "date-time",
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Hero slider not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
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
  "/search": {
    get: {
      tags: ["Search"],
      summary: "Search products, categories, and pages",
      description: "Search across multiple content types with various filters",
      parameters: [
        {
          name: "q",
          in: "query",
          description: "Search query string",
          required: false,
          schema: {
            type: "string",
          },
        },
        {
          name: "categoryId",
          in: "query",
          description: "Filter products by category ID",
          required: false,
          schema: {
            type: "string",
          },
        },
        {
          name: "minPrice",
          in: "query",
          description: "Minimum price for product results",
          required: false,
          schema: {
            type: "number",
          },
        },
        {
          name: "maxPrice",
          in: "query",
          description: "Maximum price for product results",
          required: false,
          schema: {
            type: "number",
          },
        },
        {
          name: "limit",
          in: "query",
          description: "Maximum number of results to return per content type",
          required: false,
          schema: {
            type: "integer",
            default: 10,
          },
        },
        {
          name: "searchPages",
          in: "query",
          description: "Whether to include pages in search results",
          required: false,
          schema: {
            type: "string",
            enum: ["true", "false"],
            default: "true",
          },
        },
        {
          name: "searchCategories",
          in: "query",
          description: "Whether to include categories in search results",
          required: false,
          schema: {
            type: "string",
            enum: ["true", "false"],
            default: "true",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully performed search",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  products: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "prod_123",
                        },
                        name: {
                          type: "string",
                          example: "Product Name",
                        },
                        description: {
                          type: "string",
                          nullable: true,
                          example: "Product description text",
                        },
                        price: {
                          type: "number",
                          example: 1000,
                        },
                        slug: {
                          type: "string",
                          example: "product-name",
                        },
                        imageUrl: {
                          type: "string",
                          nullable: true,
                          example: "https://cdn.scalius.com/image.png",
                        },
                        categoryId: {
                          type: "string",
                          example: "cat_123",
                        },
                        categoryName: {
                          type: "string",
                          nullable: true,
                          example: "Category Name",
                        },
                        type: {
                          type: "string",
                          example: "product",
                        },
                      },
                    },
                  },
                  categories: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "cat_123",
                        },
                        name: {
                          type: "string",
                          example: "Category Name",
                        },
                        slug: {
                          type: "string",
                          example: "category-name",
                        },
                        description: {
                          type: "string",
                          nullable: true,
                          example: "Category description",
                        },
                        type: {
                          type: "string",
                          example: "category",
                        },
                      },
                    },
                  },
                  pages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "page_123",
                        },
                        title: {
                          type: "string",
                          example: "Page Title",
                        },
                        slug: {
                          type: "string",
                          example: "page-title",
                        },
                        content: {
                          type: "string",
                          example: "Page content text",
                        },
                        type: {
                          type: "string",
                          example: "page",
                        },
                      },
                    },
                  },
                  success: {
                    type: "boolean",
                    example: true,
                  },
                  query: {
                    type: "string",
                    example: "search query",
                  },
                  timestamp: {
                    type: "string",
                    format: "date-time",
                    example: "2023-07-01T12:00:00Z",
                  },
                },
              },
            },
          },
        },
        "429": {
          description: "Too Many Requests - Rate limit exceeded",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to perform search",
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
  "/search/reindex": {
    post: {
      tags: ["Search"],
      summary: "Reindex all searchable content",
      description:
        "Manually trigger reindexing of all products, categories, and pages",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Successfully reindexed content",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  productsCount: {
                    type: "integer",
                    example: 100,
                  },
                  categoriesCount: {
                    type: "integer",
                    example: 10,
                  },
                  pagesCount: {
                    type: "integer",
                    example: 5,
                  },
                  success: {
                    type: "boolean",
                    example: true,
                  },
                  message: {
                    type: "string",
                    example: "Successfully reindexed all data",
                  },
                  timestamp: {
                    type: "string",
                    format: "date-time",
                    example: "2023-07-01T12:00:00Z",
                  },
                },
              },
            },
          },
        },
        "401": {
          description: "Unauthorized - Invalid authorization",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to reindex content",
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
  "/header": {
    get: {
      tags: ["Header"],
      summary: "Get header data",
      description:
        "Returns header configuration including logo, contact info, and social links",
      responses: {
        "200": {
          description: "Successfully retrieved header data",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  header: {
                    type: "object",
                    properties: {
                      topBar: {
                        type: "object",
                        properties: {
                          text: {
                            type: "string",
                            example: "Free shipping on all orders over ৳1000",
                          },
                        },
                      },
                      logo: {
                        type: "object",
                        properties: {
                          src: {
                            type: "string",
                            example: "https://cdn.scalius.com/logo.png",
                          },
                          alt: {
                            type: "string",
                            example: "Store Logo",
                          },
                        },
                      },
                      favicon: {
                        type: "object",
                        nullable: true,
                        properties: {
                          src: { type: "string" },
                          alt: { type: "string" },
                        },
                      },
                      contact: {
                        type: "object",
                        properties: {
                          phone: {
                            type: "string",
                            example: "+8801700000000",
                          },
                          text: {
                            type: "string",
                            example: "Customer Support",
                          },
                        },
                      },
                      social: {
                        type: "object",
                        properties: {
                          facebook: {
                            type: "string",
                            example: "https://facebook.com/storepage",
                          },
                        },
                      },
                    },
                  },
                  success: {
                    type: "boolean",
                    example: true,
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Header configuration not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch header data",
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
  "/footer": {
    get: {
      tags: ["Footer"],
      summary: "Get footer data",
      description:
        "Returns footer configuration including logo, menus, and social links",
      responses: {
        "200": {
          description: "Successfully retrieved footer data",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "object",
                    properties: {
                      logo: {
                        type: "object",
                        properties: {
                          src: { type: "string" },
                          alt: { type: "string" },
                        },
                      },
                      tagline: { type: "string" },
                      copyrightText: { type: "string" },
                      menus: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            title: { type: "string" },
                            links: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  title: { type: "string" },
                                  href: { type: "string" },
                                  // Supporting recursion if possible, or loose typing
                                  subMenu: {
                                    type: "array",
                                    items: {
                                      type: "object",
                                      additionalProperties: true,
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      social: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            platform: { type: "string" },
                            url: { type: "string" },
                            icon: { type: "string" },
                          },
                        },
                      },
                      description: { type: "string" },
                    },
                  },
                  success: { type: "boolean" },
                },
              },
            },
          },
        },
        "404": {
          description: "Footer configuration not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch footer data",
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
  "/navigation": {
    get: {
      tags: ["Navigation"],
      summary: "Get navigation menus",
      description: "Returns navigation menu structure for header and/or footer",
      parameters: [
        {
          name: "type",
          in: "query",
          description: "Type of navigation to retrieve",
          required: false,
          schema: {
            type: "string",
            enum: ["header", "footer", "all"],
            default: "all",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved navigation data",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  navigation: {
                    type: "object",
                    properties: {
                      header: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: {
                              type: "string",
                              example: "Home",
                            },
                            href: {
                              type: "string",
                              example: "/",
                            },
                            subMenu: {
                              type: "array",
                              items: {
                                type: "object",
                                additionalProperties: true,
                              },
                            },
                          },
                        },
                      },
                      footer: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: {
                              type: "string",
                              example: "footer-menu-1",
                            },
                            title: {
                              type: "string",
                              example: "Quick Links",
                            },
                            links: {
                              type: "array",
                              items: {
                                type: "object",
                                additionalProperties: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  success: {
                    type: "boolean",
                    example: true,
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Navigation configuration not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch navigation data",
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
  "/navigation/{id}": {
    get: {
      tags: ["Navigation"],
      summary: "Get specific navigation menu by ID",
      description: "Returns a specific navigation menu structure by ID",
      parameters: [
        {
          name: "id",
          in: "path",
          description:
            "ID of the navigation menu to retrieve (header, footer, or a specific menu ID)",
          required: true,
          schema: {
            type: "string",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved navigation menu",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  menu: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        example: "header",
                      },
                      name: {
                        type: "string",
                        example: "Header Navigation",
                      },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: {
                              type: "string",
                              example: "Home",
                            },
                            href: {
                              type: "string",
                              example: "/",
                            },
                            subMenu: {
                              type: "array",
                              items: {
                                type: "object",
                                additionalProperties: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  success: {
                    type: "boolean",
                    example: true,
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Navigation menu not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch navigation menu",
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
  "/pages": {
    get: {
      tags: ["Pages"],
      summary: "Get all pages",
      description: "Returns a list of CMS pages with pagination",
      parameters: [
        {
          name: "limit",
          in: "query",
          description: "Number of pages to return",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
        },
        {
          name: "page",
          in: "query",
          description: "Page number for pagination",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            default: 1,
          },
        },
        {
          name: "sort",
          in: "query",
          description:
            "Sort field and direction (prefix with - for descending)",
          required: false,
          schema: {
            type: "string",
            enum: ["title", "createdAt", "-title", "-createdAt"],
            default: "title",
          },
        },
        {
          name: "publishedOnly",
          in: "query",
          description: "Only return published pages",
          required: false,
          schema: {
            type: "boolean",
            default: true,
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved pages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  pages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        title: { type: "string" },
                        slug: { type: "string" },
                        content: { type: "string" },
                        metaTitle: { type: "string", nullable: true },
                        metaDescription: { type: "string", nullable: true },
                        isPublished: { type: "boolean" },
                        createdAt: { type: "number" },
                        updatedAt: { type: "number" },
                      },
                    },
                  },
                  pagination: {
                    type: "object",
                    properties: {
                      page: { type: "number" },
                      limit: { type: "number" },
                      total: { type: "number" },
                      totalPages: { type: "number" },
                    },
                  },
                  success: { type: "boolean" },
                },
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch pages",
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
  "/pages/slug/{slug}": {
    get: {
      tags: ["Pages"],
      summary: "Get page by slug",
      description: "Returns a specific page by its slug",
      parameters: [
        {
          name: "slug",
          in: "path",
          description: "Slug of the page to retrieve",
          required: true,
          schema: {
            type: "string",
          },
        },
      ],
      responses: {
        "200": {
          description: "Successfully retrieved page",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  page: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      slug: { type: "string" },
                      content: { type: "string" },
                      metaTitle: { type: "string", nullable: true },
                      metaDescription: { type: "string", nullable: true },
                      isPublished: { type: "boolean" },
                      createdAt: { type: "number" },
                      updatedAt: { type: "number" },
                    },
                  },
                  success: { type: "boolean" },
                },
              },
            },
          },
        },
        "404": {
          description: "Page not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/Error",
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch page",
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
