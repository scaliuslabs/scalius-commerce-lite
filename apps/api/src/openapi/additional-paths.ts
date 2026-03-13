// src/server/openapi/additional-paths.ts
export const additionalPaths = {
  "/discounts/validate": {
    get: {
      tags: ["Discounts"],
      summary: "Validate a discount code",
      description:
        "Checks if a discount code is valid and active. It can also calculate the discount amount based on the current cart total, items, and shipping cost. This is typically used in the cart or checkout page before applying a discount.\n\n**Collection Support**: Discounts can be applied to specific products, collections, or both. Collections are automatically expanded to include all products from their associated categories (config.categoryIds) plus any specifically selected products (config.productIds). This ensures collection-based discounts work correctly.",
      parameters: [
        {
          name: "code",
          in: "query",
          required: true,
          description: "The discount code to validate.",
          schema: { type: "string" },
        },
        {
          name: "total",
          in: "query",
          required: false,
          description: "The current order total (subtotal + shipping).",
          schema: { type: "number" },
        },
        {
          name: "items",
          in: "query",
          required: false,
          description:
            'A JSON string of cart items. Required for product-specific and collection-based discounts. Collections are automatically expanded to their products. Example: `[{"id":"prod_123","price":100,"quantity":1}]`',
          schema: { type: "string" },
        },
        {
          name: "shippingCost",
          in: "query",
          required: false,
          description:
            "The current shipping cost. Required for `free_shipping` discounts.",
          schema: { type: "number", default: 0 },
        },
        {
          name: "customerPhone",
          in: "query",
          required: false,
          description:
            "Customer's phone number, used for 'limit one per customer' validation.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "The result of the discount validation.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    title: "Valid Discount",
                    properties: {
                      valid: { type: "boolean", example: true },
                      discount: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          code: { type: "string" },
                          type: { type: "string" },
                          valueType: { type: "string" },
                          discountValue: { type: "number" },
                          combinable: {
                            type: "object",
                            description:
                              "Rules for combining this discount with others.",
                            properties: {
                              withProductDiscounts: { type: "boolean" },
                              withOrderDiscounts: { type: "boolean" },
                              withShippingDiscounts: { type: "boolean" },
                            },
                          },
                        },
                      },
                      discountAmount: {
                        type: "number",
                        description: "The calculated discount value.",
                      },
                    },
                  },
                  {
                    type: "object",
                    title: "Invalid Discount",
                    properties: {
                      valid: { type: "boolean", example: false },
                      error: {
                        type: "string",
                        description: "Reason why the discount is invalid.",
                      },
                      minPurchaseAmount: {
                        type: "number",
                        nullable: true,
                        description:
                          "The minimum purchase amount required, if applicable.",
                      },
                      minQuantity: {
                        type: "number",
                        nullable: true,
                        description:
                          "The minimum item quantity required, if applicable.",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/discounts/usage": {
    post: {
      tags: ["Discounts"],
      summary: "Record discount usage",
      description:
        "Records that a discount code was used in an order. This should be called after an order is successfully created.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["discountId", "orderId", "amountDiscounted"],
              properties: {
                discountId: { type: "string" },
                orderId: { type: "string" },
                customerId: { type: "string", nullable: true },
                amountDiscounted: { type: "number" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Successfully recorded discount usage.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  id: {
                    type: "string",
                    description: "The ID of the new discount usage record.",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/locations/cities": {
    get: {
      tags: ["Locations"],
      summary: "Get all delivery cities",
      description:
        "Returns a list of all active cities available for delivery. This is the first step in a hierarchical location selector (City -> Zone -> Area).",
      responses: {
        "200": {
          description: "A list of active cities.",
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
                        id: { type: "string" },
                        name: { type: "string" },
                        type: { type: "string", example: "city" },
                        parentId: { type: "string", nullable: true },
                        isActive: { type: "boolean" },
                        sortOrder: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/locations/zones": {
    get: {
      tags: ["Locations"],
      summary: "Get delivery zones for a city",
      description:
        "Returns a list of all active zones for a specified city ID. Call this after the user has selected a city.",
      parameters: [
        {
          name: "cityId",
          in: "query",
          required: true,
          description: "The ID of the parent city.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "A list of active zones for the specified city.",
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
                        id: { type: "string" },
                        name: { type: "string" },
                        type: { type: "string", example: "zone" },
                        parentId: { type: "string" },
                        isActive: { type: "boolean" },
                        sortOrder: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/locations/areas": {
    get: {
      tags: ["Locations"],
      summary: "Get delivery areas for a zone",
      description:
        "Returns a list of all active areas for a specified zone ID. Call this after the user has selected a zone. This step may be optional depending on `fieldVisibility` settings.",
      parameters: [
        {
          name: "zoneId",
          in: "query",
          required: true,
          description: "The ID of the parent zone.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "A list of active areas for the specified zone.",
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
                        id: { type: "string" },
                        name: { type: "string" },
                        type: { type: "string", example: "area" },
                        parentId: { type: "string" },
                        isActive: { type: "boolean" },
                        sortOrder: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/checkout-languages/active": {
    get: {
      tags: ["Checkout Languages"],
      summary: "Get the active checkout language",
      description:
        "Returns the complete configuration for the active checkout language, including all text labels, placeholders, and rules for which form fields should be visible. This single endpoint provides all the necessary text and configuration to render the checkout page.",
      responses: {
        "200": {
          description: "The active checkout language configuration.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  language: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      code: { type: "string" },
                      languageData: {
                        type: "object",
                        description:
                          "All text labels and messages for the checkout page.",
                        properties: {
                          pageTitle: { type: "string" },
                          checkoutSectionTitle: { type: "string" },
                          cartSectionTitle: { type: "string" },
                          customerNameLabel: { type: "string" },
                          customerNamePlaceholder: { type: "string" },
                          customerPhoneLabel: { type: "string" },
                          customerPhonePlaceholder: { type: "string" },
                          customerPhoneHelp: { type: "string" },
                          customerEmailLabel: { type: "string" },
                          customerEmailPlaceholder: { type: "string" },
                          shippingAddressLabel: { type: "string" },
                          shippingAddressPlaceholder: { type: "string" },
                          cityLabel: { type: "string" },
                          zoneLabel: { type: "string" },
                          areaLabel: { type: "string" },
                          shippingMethodLabel: { type: "string" },
                          orderNotesLabel: { type: "string" },
                          orderNotesPlaceholder: { type: "string" },
                          subtotalText: { type: "string" },
                          shippingText: { type: "string" },
                          discountText: { type: "string" },
                          totalText: { type: "string" },
                          discountCodePlaceholder: { type: "string" },
                          applyDiscountText: { type: "string" },
                          removeDiscountText: { type: "string" },
                          placeOrderText: { type: "string" },
                          processingText: { type: "string" },
                          emptyCartText: { type: "string" },
                          continueShoppingText: { type: "string" },
                          termsText: { type: "string" },
                          processingOrderTitle: { type: "string" },
                          processingOrderMessage: { type: "string" },
                          requiredFieldIndicator: { type: "string" },
                        },
                      },
                      fieldVisibility: {
                        type: "object",
                        description:
                          "Rules for showing or hiding optional form fields.",
                        properties: {
                          showEmailField: { type: "boolean" },
                          showOrderNotesField: { type: "boolean" },
                          showAreaField: { type: "boolean" },
                        },
                      },
                      isActive: { type: "boolean" },
                      isDefault: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/widgets/{id}": {
    get: {
      tags: ["Widgets"],
      summary: "Get a widget by ID",
      description:
        "Returns a single active widget by its unique ID. The response includes the raw HTML and CSS content to be rendered on the storefront.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the widget.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "The requested widget.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  widget: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: {
                        type: "string",
                        description: "Internal name for the widget.",
                      },
                      htmlContent: {
                        type: "string",
                        description: "The raw HTML content of the widget.",
                      },
                      cssContent: {
                        type: "string",
                        nullable: true,
                        description: "Optional CSS for the widget.",
                      },
                      isActive: { type: "boolean" },
                      displayTarget: { type: "string", enum: ["homepage"] },
                      placementRule: {
                        type: "string",
                        enum: [
                          "before_collection",
                          "after_collection",
                          "fixed_top_homepage",
                          "fixed_bottom_homepage",
                          "standalone",
                        ],
                      },
                      referenceCollectionId: {
                        type: "string",
                        nullable: true,
                        description:
                          "The ID of the collection this widget is placed relative to.",
                      },
                      sortOrder: { type: "number" },
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
        "404": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/widgets/active/homepage": {
    get: {
      tags: ["Widgets"],
      summary: "Get all active homepage widgets",
      description:
        "Returns a list of all active widgets configured for the homepage, sorted by their placement rule and sort order. The storefront can use this list to dynamically inject custom HTML/CSS content at various locations on the homepage.",
      responses: {
        "200": {
          description: "A list of active widgets for the homepage.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  widgets: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        htmlContent: { type: "string" },
                        cssContent: { type: "string", nullable: true },
                        isActive: { type: "boolean" },
                        displayTarget: { type: "string", enum: ["homepage"] },
                        placementRule: {
                          type: "string",
                          enum: [
                            "before_collection",
                            "after_collection",
                            "fixed_top_homepage",
                            "fixed_bottom_homepage",
                            "standalone",
                          ],
                        },
                        referenceCollectionId: {
                          type: "string",
                          nullable: true,
                        },
                        sortOrder: { type: "number" },
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
        },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/seo": {
    get: {
      tags: ["SEO"],
      summary: "Get global SEO settings",
      description:
        "Returns global SEO configuration for the site, including default titles, meta descriptions, and the content for `robots.txt`. This data is used for the site's overall SEO strategy and for pages that don't have their own specific metadata.",
      responses: {
        "200": {
          description: "Global SEO settings.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  siteTitle: {
                    type: "string",
                    nullable: true,
                    description:
                      "The general title for the entire site, used as a suffix or default.",
                  },
                  homepageTitle: {
                    type: "string",
                    nullable: true,
                    description: "The specific SEO title for the homepage.",
                  },
                  homepageMetaDescription: {
                    type: "string",
                    nullable: true,
                    description:
                      "The specific meta description for the homepage.",
                  },
                  robotsTxt: {
                    type: "string",
                    nullable: true,
                    description: "The raw content for the `robots.txt` file.",
                  },
                  success: { type: "boolean", example: true },
                },
              },
            },
          },
        },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
};
