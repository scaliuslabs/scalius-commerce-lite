// src/server/openapi/order-paths.ts
export const orderPaths = {
  "/orders": {
    get: {
      tags: ["Orders"],
      summary: "List all orders",
      description:
        "Returns a paginated list of orders. Supports filtering by status and searching by order ID, customer name, or phone number. Essential for the main order management view in an admin panel.",
      security: [{ bearerAuth: [] }],
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
          description: "Number of orders per page.",
          required: false,
          schema: { type: "integer", default: 10, minimum: 1, maximum: 100 },
        },
        {
          name: "status",
          in: "query",
          description: "Filter orders by a specific status.",
          required: false,
          schema: {
            type: "string",
            enum: [
              "pending",
              "processing",
              "confirmed",
              "shipped",
              "delivered",
              "cancelled",
              "returned",
            ],
          },
        },
        {
          name: "search",
          in: "query",
          description:
            "Search query for order ID, customer name, or customer phone.",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "sort",
          in: "query",
          description: "The field to sort the orders by.",
          required: false,
          schema: {
            type: "string",
            enum: [
              "customerName",
              "totalAmount",
              "status",
              "createdAt",
              "updatedAt",
            ],
            default: "updatedAt",
          },
        },
        {
          name: "order",
          in: "query",
          description: "The sort direction.",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        {
          name: "trashed",
          in: "query",
          description:
            "Set to 'true' to list soft-deleted orders instead of active ones.",
          required: false,
          schema: { type: "string", enum: ["true", "false"] },
        },
      ],
      responses: {
        "200": {
          description: "A paginated list of orders.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  orders: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", example: "P10GRL" },
                        customerName: {
                          type: "string",
                          example: "John Doe",
                        },
                        customerPhone: {
                          type: "string",
                          example: "01774452222",
                        },
                        customerEmail: {
                          type: "string",
                          nullable: true,
                          example: "john@example.com",
                        },
                        customerId: {
                          type: "string",
                          nullable: true,
                          example: "cust_qpG6vaiupfBccwoEw1IYT",
                        },
                        totalAmount: { type: "number", example: 5318 },
                        shippingCharge: { type: "number", example: 110 },
                        discountAmount: {
                          type: "number",
                          example: 0,
                        },
                        status: { type: "string", example: "pending" },
                        city: {
                          type: "string",
                          example: "d6smoije4odr7887z40zy2z8",
                        },
                        zone: {
                          type: "string",
                          example: "uiljxeeki5idue50937a8aw2",
                        },
                        area: { type: "string", nullable: true },
                        cityName: { type: "string", example: "Bagerhat" },
                        zoneName: { type: "string", example: "Bagerhat Sadar" },
                        areaName: { type: "string", nullable: true },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                        itemCount: {
                          type: "integer",
                          description:
                            "The number of unique line items in the order.",
                          example: 1,
                        },
                        totalQuantity: {
                          type: "integer",
                          description:
                            "The total number of all units in the order.",
                          example: 1,
                        },
                      },
                    },
                  },
                  pagination: {
                    type: "object",
                    properties: {
                      page: { type: "integer", example: 1 },
                      limit: { type: "integer", example: 10 },
                      total: { type: "integer", example: 1781 },
                      totalPages: { type: "integer", example: 179 },
                      hasNextPage: { type: "boolean", example: true },
                      hasPrevPage: { type: "boolean", example: false },
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
    post: {
      tags: ["Orders"],
      summary: "Create a new order",
      description:
        "Creates a new order, updates customer statistics, and decrements product stock. Upon successful creation, it also triggers a notification to admins. Note: `city`, `zone`, and `area` must be valid location IDs obtained from the `/locations` endpoints.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
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
                customerName: {
                  type: "string",
                  minLength: 3,
                  maxLength: 100,
                  example: "Jane Doe",
                },
                customerPhone: {
                  type: "string",
                  description: "Must be a valid Bangladeshi phone number.",
                  pattern: "^(\\+88)?01[3-9]\\d{8}$",
                  example: "01712345678",
                },
                customerEmail: {
                  type: "string",
                  format: "email",
                  nullable: true,
                  example: "jane.doe@example.com",
                },
                shippingAddress: {
                  type: "string",
                  minLength: 10,
                  maxLength: 500,
                  example: "123 Test Street, Test Block, Test City",
                },
                city: {
                  type: "string",
                  description: "City ID from `/locations/cities`.",
                  example: "d6smoije4odr7887z40zy2z8",
                },
                zone: {
                  type: "string",
                  description: "Zone ID from `/locations/zones`.",
                  example: "uiljxeeki5idue50937a8aw2",
                },
                area: {
                  type: "string",
                  nullable: true,
                  description: "Area ID from `/locations/areas` (optional).",
                },
                cityName: {
                  type: "string",
                  description: "Name of the city (for display/record-keeping).",
                  example: "Bagerhat",
                },
                zoneName: {
                  type: "string",
                  description: "Name of the zone (for display/record-keeping).",
                  example: "Bagerhat Sadar",
                },
                areaName: {
                  type: "string",
                  nullable: true,
                  description: "Name of the area (for display/record-keeping).",
                },
                notes: {
                  type: "string",
                  maxLength: 500,
                  nullable: true,
                  example: "Please call before delivery.",
                },
                items: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    required: ["productId", "quantity", "price"],
                    properties: {
                      productId: {
                        type: "string",
                        example: "prod_KIY35Mdn1Bc8bsUq3fcn5",
                      },
                      variantId: {
                        type: "string",
                        nullable: true,
                        example: "var_vC_r149Ypu0FTKw1BsgxD",
                      },
                      quantity: { type: "integer", minimum: 1, example: 1 },
                      price: {
                        type: "number",
                        minimum: 0,
                        description:
                          "The final price per unit for this line item.",
                        example: 5208,
                      },
                    },
                  },
                },
                discountAmount: {
                  type: "number",
                  minimum: 0,
                  nullable: true,
                  example: 100,
                },
                discountCode: {
                  type: "string",
                  nullable: true,
                  description:
                    "If a discount was applied, include its code to log usage.",
                  example: "SUMMER10",
                },
                shippingCharge: {
                  type: "number",
                  minimum: 0,
                  example: 110,
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Order created successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        description:
                          "The unique ID of the newly created order.",
                        example: "T6UWMI",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Bad Request - Caused by either a validation error or insufficient stock.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    title: "Validation Error",
                    properties: {
                      success: { type: "boolean", example: false },
                      error: {
                        type: "object",
                        properties: {
                          code: { type: "string", example: "VALIDATION_ERROR" },
                          message: {
                            type: "string",
                            example: "Invalid order data",
                          },
                          details: { type: "array", items: { type: "object" } },
                        },
                      },
                    },
                  },
                  {
                    type: "object",
                    title: "Insufficient Stock Error",
                    properties: {
                      success: { type: "boolean", example: false },
                      error: {
                        type: "object",
                        properties: {
                          code: {
                            type: "string",
                            example: "INSUFFICIENT_STOCK",
                          },
                          message: {
                            type: "string",
                            example: "Insufficient stock for variant var_456",
                          },
                          variantId: { type: "string", example: "var_456" },
                          available: { type: "integer", example: 3 },
                          requested: { type: "integer", example: 5 },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/{id}": {
    get: {
      tags: ["Orders"],
      summary: "Get order details by ID",
      description:
        "Returns all details for a specific order, including customer information, full item list (with product names and images), and any associated delivery shipments.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      responses: {
        "200": {
          description: "Detailed information for the requested order.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  order: {
                    type: "object",
                    properties: {
                      id: { type: "string", example: "P10GRL" },
                      customerName: { type: "string", example: "John Doe" },
                      customerPhone: { type: "string", example: "01774452222" },
                      customerEmail: { type: "string", nullable: true },
                      customerId: { type: "string", nullable: true },
                      shippingAddress: {
                        type: "string",
                        example: "123 Test Street",
                      },
                      totalAmount: { type: "number", example: 5318 },
                      shippingCharge: { type: "number", example: 110 },
                      discountAmount: { type: "number", example: 0 },
                      notes: { type: "string", nullable: true },
                      city: { type: "string" },
                      zone: { type: "string" },
                      area: { type: "string", nullable: true },
                      cityName: { type: "string" },
                      zoneName: { type: "string" },
                      areaName: { type: "string", nullable: true },
                      status: { type: "string", example: "pending" },
                      createdAt: { type: "string", format: "date-time" },
                      updatedAt: { type: "string", format: "date-time" },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            productId: { type: "string" },
                            variantId: { type: "string", nullable: true },
                            quantity: { type: "integer", example: 1 },
                            price: { type: "number", example: 5208 },
                            productName: {
                              type: "string",
                              example: "Amazfit Bip 5 Smart Watch",
                            },
                            productImage: {
                              type: "string",
                              nullable: true,
                              example: "https://cdn.scalius.com/image.png",
                            },
                            variantSize: { type: "string", nullable: true },
                            variantColor: {
                              type: "string",
                              nullable: true,
                              example: "Black",
                            },
                          },
                        },
                      },
                      shipments: {
                        type: "array",
                        description:
                          "A list of delivery shipments associated with this order.",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            providerId: { type: "string" },
                            providerType: { type: "string", example: "pathao" },
                            trackingId: { type: "string", nullable: true },
                            status: { type: "string" },
                            createdAt: { type: "string", format: "date-time" },
                          },
                        },
                        example: [],
                      },
                      deliveryProviders: {
                        type: "array",
                        description:
                          "A list of currently active delivery providers that a shipment can be created with.",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            type: { type: "string" },
                            isActive: { type: "boolean" },
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
        "404": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
    put: {
      tags: ["Orders"],
      summary: "Update an existing order",
      description:
        "Updates the details of an existing order. This operation recalculates stock based on changes to the item list (restoring stock for removed items and decrementing for new ones).",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order to update.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/OrderPostRequest" }, // Re-use the create schema
          },
        },
      },
      responses: {
        "200": {
          description: "Order updated successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string", example: "P10GRL" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "404": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
    delete: {
      tags: ["Orders"],
      summary: "Soft delete an order",
      description:
        "Marks an order as deleted by setting the `deletedAt` timestamp. It also restores the stock for all items in the order.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order to soft delete.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      responses: {
        "204": { description: "Order soft-deleted successfully." },
        "404": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/{id}/items": {
    get: {
      tags: ["Orders"],
      summary: "Get an order's items",
      description:
        "A lightweight endpoint to quickly fetch just the line items for a specific order, useful for UI elements like popovers in an order list.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      responses: {
        "200": {
          description: "A list of items in the order.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    productId: { type: "string" },
                    variantId: { type: "string", nullable: true },
                    quantity: { type: "integer" },
                    price: { type: "number" },
                    productName: { type: "string" },
                    productImage: { type: "string", nullable: true },
                    variantSize: { type: "string", nullable: true },
                    variantColor: { type: "string", nullable: true },
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
  "/orders/products-for-form": {
    get: {
      tags: ["Orders"],
      summary: "Get products for order creation form",
      description:
        "Returns a list of all active products and their variants, structured specifically for populating a product selection dropdown or search in an order creation/editing form.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "A list of products with their nested variants.",
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
                        id: { type: "string" },
                        name: { type: "string" },
                        price: { type: "number" },
                        discountPercentage: { type: "number", nullable: true },
                        variants: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              productId: { type: "string" },
                              size: { type: "string", nullable: true },
                              color: { type: "string", nullable: true },
                              weight: { type: "number", nullable: true },
                              sku: { type: "string", nullable: true },
                              price: { type: "number", nullable: true },
                              stock: { type: "integer" },
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
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/bulk-delete": {
    post: {
      tags: ["Orders"],
      summary: "Bulk delete orders",
      description:
        "Soft deletes or permanently deletes multiple orders at once. Stock is restored for all items in the deleted orders.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["orderIds"],
              properties: {
                orderIds: {
                  type: "array",
                  items: { type: "string" },
                  example: ["P10GRL", "T6UWMI"],
                  minItems: 1,
                },
                permanent: {
                  type: "boolean",
                  default: false,
                  description:
                    "If true, permanently deletes the orders from the database. If false (default), orders are soft-deleted.",
                },
              },
            },
          },
        },
      },
      responses: {
        "204": { description: "Orders deleted successfully." },
        "400": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/{id}/restore": {
    post: {
      tags: ["Orders"],
      summary: "Restore a soft-deleted order",
      description:
        "Restores a soft-deleted order by clearing its `deletedAt` timestamp. It also decrements the stock for all items in the order.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order to restore.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      responses: {
        "204": { description: "Order restored successfully." },
        "400": { description: "Bad Request - The order is not deleted." },
        "404": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/{id}/status": {
    put: {
      tags: ["Orders"],
      summary: "Update an order's status",
      description: "Quickly updates the status of a single order.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["status"],
              properties: {
                status: {
                  type: "string",
                  enum: [
                    "pending",
                    "processing",
                    "confirmed",
                    "shipped",
                    "delivered",
                    "cancelled",
                    "returned",
                  ],
                  example: "confirmed",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Order status updated successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  data: {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        example: "Order status updated successfully",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
  "/orders/{id}/permanent": {
    delete: {
      tags: ["Orders"],
      summary: "Permanently delete an order",
      description:
        "Permanently removes an order and its associated items from the database. If the order was not already soft-deleted, stock will be restored first. This action is irreversible.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "The unique ID of the order to permanently delete.",
          schema: { type: "string", example: "P10GRL" },
        },
      ],
      responses: {
        "204": { description: "Order permanently deleted successfully." },
        "404": { $ref: "#/components/schemas/Error" },
        "401": { $ref: "#/components/schemas/Error" },
        "500": { $ref: "#/components/schemas/Error" },
      },
    },
  },
};
