// src/server/openapi/product-paths.ts
export const productPaths = {
  "/products": {
    get: {
      tags: ["Products"],
      summary: "List all products with filtering",
      description:
        "Returns a paginated list of products. This endpoint supports advanced filtering by category, price range, and dynamic product attributes, as well as searching and sorting. It's the primary endpoint for building product listing pages (PLP) or shop pages.",
      parameters: [
        {
          name: "page",
          in: "query",
          description: "Page number for pagination.",
          required: false,
          schema: { type: "integer", default: 1, minimum: 1 },
        },
        {
          name: "limit",
          in: "query",
          description: "Number of products per page.",
          required: false,
          schema: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        },
        {
          name: "category",
          in: "query",
          description: "Filter by a specific category ID.",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "search",
          in: "query",
          description: "Search term to filter products by name.",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "sort",
          in: "query",
          description: "Sort order for the products.",
          required: false,
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
          name: "minPrice",
          in: "query",
          description: "Filter by a minimum price.",
          required: false,
          schema: { type: "number", minimum: 0 },
        },
        {
          name: "maxPrice",
          in: "query",
          description: "Filter by a maximum price.",
          required: false,
          schema: { type: "number", minimum: 0 },
        },
        {
          name: "freeDelivery",
          in: "query",
          description: "Filter for products that have free delivery.",
          required: false,
          schema: { type: "string", enum: ["true", "false"] },
        },
        {
          name: "hasDiscount",
          in: "query",
          description: "Filter for products that have a discount.",
          required: false,
          schema: { type: "string", enum: ["true", "false"] },
        },
        {
          name: "ids",
          in: "query",
          description:
            "Fetch a specific set of products by their comma-separated IDs.",
          required: false,
          schema: { type: "string", example: "prod_123,prod_456,prod_789" },
        },
        {
          name: "[attribute_slug]",
          in: "query",
          description:
            "Dynamically filter by any attribute slug (e.g., `brand=Samsung`, `warranty=2-year`). Obtain available attribute slugs from the `/attributes/filterable` endpoint. Multiple attribute filters can be combined.",
          required: false,
          style: "form",
          explode: true,
          schema: { type: "string" },
          example: "brand=Samsung&color=Black",
        },
      ],
      responses: {
        "200": {
          description: "A paginated list of products.",
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
                          example: "prod_20b5u8VDOcSnP8x_0pjSt",
                        },
                        name: { type: "string", example: "Samsung Galaxy S23" },
                        price: { type: "number", example: 50000 },
                        slug: { type: "string", example: "samsung-galaxy-s23" },
                        discountType: {
                          type: "string",
                          enum: ["percentage", "flat"],
                          example: "percentage",
                          description: "Type of discount applied to the product",
                        },
                        discountPercentage: {
                          type: "number",
                          nullable: true,
                          example: 10,
                          description: "Discount percentage (0-100) when discountType is 'percentage'",
                        },
                        discountAmount: {
                          type: "number",
                          nullable: true,
                          example: 5000,
                          description: "Flat discount amount when discountType is 'flat'",
                        },
                        freeDelivery: { type: "boolean", example: false },
                        categoryId: {
                          type: "string",
                          example: "cat_T07m1YNkrTiBuAuAx-nUb",
                        },
                        imageUrl: {
                          type: "string",
                          nullable: true,
                          description: "URL of the product's primary image.",
                          example: "https://cdn.scalius.com/galaxy-s23.png",
                        },
                        category: {
                          type: "object",
                          nullable: true,
                          properties: {
                            id: {
                              type: "string",
                              example: "cat_T07m1YNkrTiBuAuAx-nUb",
                            },
                            name: { type: "string", example: "SmartPhones" },
                            slug: { type: "string", example: "smartphones" },
                          },
                        },
                        discountedPrice: {
                          type: "number",
                          description:
                            "The price after the discount percentage has been applied. Equal to `price` if no discount.",
                          example: 45000,
                        },
                        hasVariants: {
                          type: "boolean",
                          description:
                            "Indicates if the product has multiple variants (e.g., by size or color).",
                          example: true,
                        },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  pagination: {
                    type: "object",
                    properties: {
                      page: { type: "integer", example: 1 },
                      limit: { type: "integer", example: 20 },
                      total: { type: "integer", example: 25 },
                      totalPages: { type: "integer", example: 2 },
                    },
                  },
                },
              },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch products",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/products/{slug}": {
    get: {
      tags: ["Products"],
      summary: "Get a single product by slug",
      description:
        "Returns detailed information for a specific product, including all its images, variants, attributes, rich content sections, and related products. This is the primary endpoint for building a product detail page (PDP).",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: "The URL-friendly slug of the product to retrieve.",
          schema: { type: "string", example: "amazfit-bip-5" },
        },
      ],
      responses: {
        "200": {
          description: "Detailed information for the requested product.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  product: {
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
                      description: {
                        type: "string",
                        nullable: true,
                        description:
                          "The main HTML description of the product.",
                        example:
                          "<h1>⌚ <strong>Amazfit Bip 5 Unity – Bluetooth Calling Smart Watch</strong></h1>",
                      },
                      price: { type: "number", example: 5600 },
                      categoryId: {
                        type: "string",
                        example: "cat_fj1ZspPwVuHyQVCGDC0jf",
                      },
                      slug: { type: "string", example: "amazfit-bip-5" },
                      metaTitle: {
                        type: "string",
                        nullable: true,
                        example:
                          "Amazfit Bip 5 Unity – Bluetooth Calling Smartwatch",
                      },
                      metaDescription: {
                        type: "string",
                        nullable: true,
                        example:
                          'Amazfit Bip 5 Unity: Bluetooth calling, 1.91" HD display, 100+ sports modes & 11-day battery.',
                      },
                      discountType: {
                        type: "string",
                        enum: ["percentage", "flat"],
                        example: "percentage",
                        description: "Type of discount applied to the product",
                      },
                      discountPercentage: {
                        type: "number",
                        nullable: true,
                        example: 7,
                        description: "Discount percentage (0-100) when discountType is 'percentage'",
                      },
                      discountAmount: {
                        type: "number",
                        nullable: true,
                        example: 0,
                        description: "Flat discount amount when discountType is 'flat'",
                      },
                      freeDelivery: { type: "boolean", example: false },
                      isActive: { type: "boolean", example: true },
                      features: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "A list of key features extracted from the product description.",
                        example: [
                          "Bluetooth Calling",
                          '1.91" HD Display',
                          "11-Day Battery Life",
                        ],
                      },
                      discountedPrice: { type: "number", example: 5208 },
                      hasVariants: {
                        type: "boolean",
                        description:
                          "Indicates if the product has multiple variants (e.g., by size or color).",
                        example: true,
                      },
                      createdAt: {
                        type: "string",
                        format: "date-time",
                        example: "2025-06-02T15:27:31.000Z",
                      },
                      updatedAt: {
                        type: "string",
                        format: "date-time",
                        example: "2025-06-30T18:10:28.000Z",
                      },
                      deletedAt: {
                        type: "string",
                        nullable: true,
                        format: "date-time",
                        example: null,
                      },
                      attributes: {
                        type: "array",
                        description:
                          "A list of filterable attributes assigned to the product.",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string", example: "Brand" },
                            value: { type: "string", example: "Amazfit" },
                            slug: { type: "string", example: "brand" },
                          },
                        },
                      },
                      additionalInfo: {
                        type: "array",
                        description:
                          "Rich content sections for the product, often used for detailed specifications or feature callouts.",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", example: "prc_123xyz" },
                            title: {
                              type: "string",
                              example: "Technical Specifications",
                            },
                            content: {
                              type: "string",
                              example:
                                "<ul><li>Display: 1.91 inch TFT</li><li>Resolution: 320x380</li><li>Water Resistance: IP68</li></ul>",
                            },
                          },
                        },
                      },
                    },
                  },
                  category: {
                    type: "object",
                    nullable: true,
                    description: "The category the product belongs to.",
                    properties: {
                      id: {
                        type: "string",
                        example: "cat_fj1ZspPwVuHyQVCGDC0jf",
                      },
                      name: { type: "string", example: "Tech Gadgets" },
                      slug: { type: "string", example: "tech-gadgets" },
                      description: {
                        type: "string",
                        nullable: true,
                      },
                      imageUrl: {
                        type: "string",
                        nullable: true,
                      },
                      metaTitle: {
                        type: "string",
                        nullable: true,
                      },
                      metaDescription: {
                        type: "string",
                        nullable: true,
                      },
                    },
                  },
                  images: {
                    type: "array",
                    description:
                      "A list of all images for the product, sorted by `sortOrder`.",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "img_h1qzC6HRQtAHbuzkhS_px",
                        },
                        productId: {
                          type: "string",
                          example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                        },
                        url: {
                          type: "string",
                          example:
                            "https://cdn.scalius.com/Nur_AVLkaIoEeFCRphKhq.png",
                        },
                        alt: {
                          type: "string",
                          example: "Amazfit Bip 5 Unity side view",
                        },
                        isPrimary: { type: "boolean", example: true },
                        sortOrder: { type: "integer", example: 0 },
                        createdAt: {
                          type: "string",
                          format: "date-time",
                        },
                      },
                    },
                  },
                  variants: {
                    type: "array",
                    description:
                      "A list of all available variants for the product (e.g., by color, size).",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "var_2bPev_-ZazMfirwpAu9Cz",
                        },
                        productId: {
                          type: "string",
                          example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                        },
                        size: { type: "string", nullable: true, example: null },
                        color: {
                          type: "string",
                          nullable: true,
                          example: "White",
                        },
                        weight: {
                          type: "number",
                          nullable: true,
                          example: 170,
                        },
                        sku: {
                          type: "string",
                          nullable: true,
                          example: "bip-5w",
                        },
                        price: {
                          type: "number",
                          description:
                            "The specific price for this variant. If null, it inherits the parent product's price.",
                          nullable: true,
                          example: 5600,
                        },
                        stock: { type: "integer", example: 11 },
                        discountType: {
                          type: "string",
                          enum: ["percentage", "flat"],
                          example: "percentage",
                          description: "Type of discount applied to this variant",
                        },
                        discountPercentage: {
                          type: "number",
                          nullable: true,
                          example: 0,
                          description: "Discount percentage for this variant",
                        },
                        discountAmount: {
                          type: "number",
                          nullable: true,
                          example: 0,
                          description: "Flat discount amount for this variant",
                        },
                        colorSortOrder: {
                          type: "integer",
                          example: 0,
                          description: "Sort order for color-based grouping (used for variant image mapping)",
                        },
                        sizeSortOrder: {
                          type: "integer",
                          example: 0,
                          description: "Sort order for size-based grouping (used for storefront display)",
                        },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                        deletedAt: {
                          type: "string",
                          nullable: true,
                          format: "date-time",
                        },
                      },
                    },
                  },
                  relatedProducts: {
                    type: "array",
                    description:
                      "A list of related products, typically from the same category.",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "prod_asV5RrtG4seFCrBJgwXbY",
                        },
                        name: {
                          type: "string",
                          example: "Meko Ti5 ANC+LCD True Wireless Earbuds",
                        },
                        price: { type: "number", example: 2200 },
                        slug: {
                          type: "string",
                          example: "meko-ti5-anc-lcd-true-wireless-earbuds",
                        },
                        discountType: {
                          type: "string",
                          enum: ["percentage", "flat"],
                          example: "percentage",
                        },
                        discountPercentage: {
                          type: "number",
                          nullable: true,
                          example: null,
                        },
                        discountAmount: {
                          type: "number",
                          nullable: true,
                          example: null,
                        },
                        freeDelivery: {
                          type: "boolean",
                          nullable: true,
                          example: true,
                        },
                        imageUrl: {
                          type: "string",
                          nullable: true,
                          example:
                            "https://cdn.scalius.com/9UiALYviYt69DdLiGSJ7t.png",
                        },
                        discountedPrice: { type: "number", example: 2200 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "Product not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to fetch product",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/products/{productId}/variants": {
    get: {
      tags: ["Products"],
      summary: "Get all variants for a product",
      description:
        "Returns a simple list of all variants for a specific product ID.",
      parameters: [
        {
          name: "productId",
          in: "path",
          required: true,
          description: "ID of the product to get variants for.",
          schema: { type: "string", example: "prod_KIY35Mdn1Bc8bsUq3fcn5" },
        },
      ],
      responses: {
        "200": {
          description: "A list of product variants.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  variants: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: {
                          type: "string",
                          example: "var_2bPev_-ZazMfirwpAu9Cz",
                        },
                        productId: {
                          type: "string",
                          example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                        },
                        size: { type: "string", nullable: true, example: null },
                        color: {
                          type: "string",
                          nullable: true,
                          example: "White",
                        },
                        weight: {
                          type: "number",
                          nullable: true,
                          example: 170,
                        },
                        sku: {
                          type: "string",
                          nullable: true,
                          example: "bip-5w",
                        },
                        price: {
                          type: "number",
                          nullable: true,
                          example: 5600,
                        },
                        stock: { type: "integer", example: 11 },
                        colorSortOrder: {
                          type: "integer",
                          example: 0,
                          description: "Sort order for color-based grouping",
                        },
                        sizeSortOrder: {
                          type: "integer",
                          example: 0,
                          description: "Sort order for size-based grouping",
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
          description: "Server Error - Failed to fetch product variants",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/products/search": {
    get: {
      tags: ["Products"],
      summary: "Search products for admin forms",
      description:
        "A simplified product search endpoint, optimized for use in admin panels, like adding a product to an order form. Returns products with their variants.",
      parameters: [
        {
          name: "search",
          in: "query",
          description: "Search term to find products by name.",
          required: false,
          schema: { type: "string", default: "" },
        },
        {
          name: "page",
          in: "query",
          description: "Page number for pagination.",
          required: false,
          schema: { type: "integer", default: 1, minimum: 1 },
        },
        {
          name: "limit",
          in: "query",
          description: "Number of products per page.",
          required: false,
          schema: { type: "integer", default: 10, minimum: 1, maximum: 100 },
        },
      ],
      responses: {
        "200": {
          description: "Successfully searched products.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "array",
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
                        discountType: {
                          type: "string",
                          enum: ["percentage", "flat"],
                          example: "percentage",
                        },
                        discountPercentage: {
                          type: "number",
                          nullable: true,
                          example: 7,
                        },
                        discountAmount: {
                          type: "number",
                          nullable: true,
                          example: 0,
                        },
                        primaryImageUrl: {
                          type: "string",
                          nullable: true,
                          example:
                            "https://cdn.scalius.com/Nur_AVLkaIoEeFCRphKhq.png",
                        },
                        variants: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: {
                                type: "string",
                                example: "var_2bPev_-ZazMfirwpAu9Cz",
                              },
                              productId: {
                                type: "string",
                                example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                              },
                              size: {
                                type: "string",
                                nullable: true,
                              },
                              color: {
                                type: "string",
                                nullable: true,
                                example: "White",
                              },
                              weight: {
                                type: "number",
                                nullable: true,
                              },
                              sku: {
                                type: "string",
                                nullable: true,
                                example: "bip-5w",
                              },
                              price: {
                                type: "number",
                                nullable: true,
                                example: 5600,
                              },
                              stock: { type: "integer", example: 11 },
                              discountType: {
                                type: "string",
                                enum: ["percentage", "flat"],
                                example: "percentage",
                              },
                              discountPercentage: {
                                type: "number",
                                nullable: true,
                                example: 0,
                              },
                              discountAmount: {
                                type: "number",
                                nullable: true,
                                example: 0,
                              },
                              colorSortOrder: {
                                type: "integer",
                                example: 0,
                                description: "Sort order for color-based grouping",
                              },
                              sizeSortOrder: {
                                type: "integer",
                                example: 0,
                                description: "Sort order for size-based grouping",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  pagination: {
                    type: "object",
                    properties: {
                      page: { type: "integer", example: 1 },
                      limit: { type: "integer", example: 10 },
                      total: { type: "integer", example: 25 },
                      totalPages: { type: "integer", example: 3 },
                      hasNextPage: { type: "boolean", example: true },
                      hasPrevPage: { type: "boolean", example: false },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Bad Request - Invalid query parameters",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        "500": {
          description: "Server Error - Failed to search products",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
};
