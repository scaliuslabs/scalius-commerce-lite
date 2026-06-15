import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { checkoutLanguages } from "@scalius/database/schema";
import { eq, and, isNull, or, like, asc, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ConflictError } from "../utils/api-error";

import { ok, created, noContent } from "../utils/api-response";
import { successEnvelope, noContentResponse, errorResponses } from "../schemas/responses";
import { optionalNullableTimestampSchema, optionalTimestampSchema } from "../schemas/timestamps";
import { invalidateApiAndScheduleStorefrontGroups } from "../utils/cache-invalidation";

type CheckoutLanguageRouteApp = OpenAPIHono<{ Bindings: Env }>;
const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;

const publicApp = new OpenAPIHono<{ Bindings: Env }>();
const adminApp = new OpenAPIHono<{ Bindings: Env }>();

const checkoutLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  languageData: z.union([z.string(), z.record(z.string(), z.unknown())]),
  fieldVisibility: z.union([z.string(), z.record(z.string(), z.unknown())]),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: optionalTimestampSchema,
  updatedAt: optionalTimestampSchema,
  deletedAt: optionalNullableTimestampSchema,
}).passthrough();

const defaultLanguageData = {
  pageTitle: "Cart & Checkout",
  checkoutSectionTitle: "Checkout Information",
  cartSectionTitle: "Shopping Cart",
  customerNameLabel: "Full Name",
  customerNamePlaceholder: "Enter your full name",
  customerPhoneLabel: "Phone Number",
  customerPhonePlaceholder: "Phone number",
  customerPhoneHelp: "Enter your phone number with country code",
  customerEmailLabel: "Email (Optional)",
  customerEmailPlaceholder: "Enter your email address",
  shippingAddressLabel: "Delivery Address",
  shippingAddressPlaceholder: "Enter your full delivery address",
  cityLabel: "City",
  zoneLabel: "Zone",
  areaLabel: "Area (Optional)",
  shippingMethodLabel: "Choose Delivery Option",
  orderNotesLabel: "Order Notes (Optional)",
  orderNotesPlaceholder: "Any special instructions for your order?",
  continueShoppingText: "Continue Shopping",
  subtotalText: "Subtotal",
  shippingText: "Shipping",
  discountText: "Discount",
  totalText: "Total",
  discountCodePlaceholder: "Discount code",
  applyDiscountText: "Apply",
  removeDiscountText: "Remove",
  placeOrderText: "Place Order",
  processingText: "Processing...",
  emptyCartText: "Your cart is empty",
  termsText: "By placing this order, you agree to our Terms of Service and Privacy Policy",
  processingOrderTitle: "Processing Your Order",
  processingOrderMessage: "Please wait while we process your order.",
  requiredFieldIndicator: "*"
};

const defaultFieldVisibility = {
  showEmailField: true,
  showOrderNotesField: true,
  showAreaField: true
};

const createCheckoutLanguageSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).openapi({ description: "Language name" }),
  code: z.string().min(1, "Code is required").max(10).openapi({ description: "Language code" }),
  languageData: z.object({}).passthrough().optional().openapi({ description: "Language strings" }),
  fieldVisibility: z.object({}).passthrough().optional().openapi({ description: "Field visibility settings" }),
  isActive: z.boolean().optional().default(false).openapi({ description: "Whether this language is active" }),
  isDefault: z.boolean().optional().default(false).openapi({ description: "Whether this is the default language" })
});

const updateCheckoutLanguageSchema = createCheckoutLanguageSchema.partial();

// GET /checkout-languages/active — get active checkout language
const getActiveRoute = createRoute({
  method: "get",
  path: "/active",
  tags: ["Checkout Languages"],
  summary: "Get active checkout language",
  responses: {
    200: {
      description: "Active checkout language",
      content: { "application/json": { schema: successEnvelope(z.object({ language: checkoutLanguageSchema })) } },
    },
    ...errorResponses,
  }
});

function registerGetActiveRoute(target: CheckoutLanguageRouteApp) {
  target.openapi(getActiveRoute, async (c) => {
    const db = c.get("db");
    let language = await db
      .select()
      .from(checkoutLanguages)
      .where(
        and(
          eq(checkoutLanguages.isActive, true),
          isNull(checkoutLanguages.deletedAt),
        ),
      )
      .get();

    if (!language) {
      language = await db
        .select()
        .from(checkoutLanguages)
        .where(
          and(
            eq(checkoutLanguages.isDefault, true),
            isNull(checkoutLanguages.deletedAt),
          ),
        )
        .get();
    }

    if (!language) {
      const fallbackFieldVisibility = {
        showEmailField: true,
        showOrderNotesField: true,
        showAreaField: true
      };

      return ok(c, {
        language: {
          id: "fallback",
          name: "English (Fallback)",
          code: "en",
          languageData: defaultLanguageData,
          fieldVisibility: fallbackFieldVisibility,
          isActive: true,
          isDefault: true
        }
      });
    }

    const parsedLanguage = {
      ...language,
      languageData: JSON.parse(language.languageData),
      fieldVisibility: JSON.parse(language.fieldVisibility)
    };

    return ok(c, { language: parsedLanguage });
  });
}

registerGetActiveRoute(publicApp);
registerGetActiveRoute(adminApp);

// GET /checkout-languages — list all checkout languages
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Checkout Languages"],
  summary: "List all checkout languages with pagination",
  request: {
    query: z.object({
      page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
      limit: z.coerce.number().optional().default(10).openapi({ description: "Items per page" }),
      search: z.string().optional().default("").openapi({ description: "Search query" }),
      sort: z.string().optional().default("name").openapi({ description: "Sort field" }),
      order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
      trashed: z.enum(["true", "false"]).optional().default("false").openapi({ description: "Show trashed items" })
    })
  },
  responses: {
    200: {
      description: "Checkout language list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({ languages: z.array(checkoutLanguageSchema), pagination: z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number(), hasNextPage: z.boolean(), hasPrevPage: z.boolean() }) })) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const q = c.req.valid("query");
  const page = q.page;
  const limit = q.limit;
  const search = q.search;
  const sortField = (q.sort || "name") as keyof typeof checkoutLanguages._.columns;
  const sortOrder = q.order;
  const showTrashed = q.trashed === "true";

  const offset = (page - 1) * limit;
  const whereConditions = [];

  if (showTrashed) {
    whereConditions.push(sql`${checkoutLanguages.deletedAt} IS NOT NULL`);
  } else {
    whereConditions.push(sql`${checkoutLanguages.deletedAt} IS NULL`);
  }

  if (search) {
    whereConditions.push(
      or(
        like(checkoutLanguages.name, `%${search}%`),
        like(checkoutLanguages.code, `%${search}%`),
      ),
    );
  }

  const combinedWhereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const results = await db
    .select()
    .from(checkoutLanguages)
    .where(combinedWhereClause)
    .orderBy(sortOrder === "asc" ? asc(checkoutLanguages[sortField]) : desc(checkoutLanguages[sortField]))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(checkoutLanguages)
    .where(combinedWhereClause)
    .get();

  const total = countResult?.count || 0;
  return ok(c, {
    languages: results,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page < Math.ceil(total / limit),
      hasPrevPage: page > 1
    }
  });
});

// POST /checkout-languages — create a new checkout language
const createRoute2 = createRoute({
  method: "post",
  path: "/",
  tags: ["Checkout Languages"],
  summary: "Create a new checkout language",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createCheckoutLanguageSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Created checkout language",
      content: { "application/json": { schema: successEnvelope(z.object({ language: checkoutLanguageSchema.optional() })) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(createRoute2, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");

  const existingLanguage = await db.select().from(checkoutLanguages).where(and(eq(checkoutLanguages.code, data.code), isNull(checkoutLanguages.deletedAt))).get();
  if (existingLanguage) {
    throw new ConflictError("A checkout language with this code already exists.");
  }

  if (data.isActive) {
    await db.update(checkoutLanguages).set({ isActive: false }).where(eq(checkoutLanguages.isActive, true));
  }
  if (data.isDefault) {
    await db.update(checkoutLanguages).set({ isDefault: false }).where(eq(checkoutLanguages.isDefault, true));
  }

  const newLanguageId = "cl_" + nanoid();
  const [insertedLanguage] = await db.insert(checkoutLanguages).values({
    id: newLanguageId,
    name: data.name,
    code: data.code,
    languageData: JSON.stringify(data.languageData || defaultLanguageData),
    fieldVisibility: JSON.stringify(data.fieldVisibility || defaultFieldVisibility),
    isActive: data.isActive || false,
    isDefault: data.isDefault || false,
    createdAt: sql`(cast(strftime('%s','now') as int))`,
    updatedAt: sql`(cast(strftime('%s','now') as int))`
  }).returning();

  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return created(c, { language: insertedLanguage });
});

// GET /checkout-languages/:id — get checkout language by ID
const getByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Checkout Languages"],
  summary: "Get checkout language by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Checkout language details",
      content: { "application/json": { schema: successEnvelope(checkoutLanguageSchema) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(getByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const language = await db.select().from(checkoutLanguages).where(eq(checkoutLanguages.id, id)).get();
  if (!language) throw new NotFoundError("Not found");
  return ok(c, language);
});

// PUT /checkout-languages/:id — update a checkout language
const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Checkout Languages"],
  summary: "Update a checkout language",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: updateCheckoutLanguageSchema
        }
      }
    }
  },
  responses: {
    200: {
      description: "Updated checkout language",
      content: { "application/json": { schema: successEnvelope(z.object({ language: checkoutLanguageSchema.optional() })) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");

  const existing = await db.select().from(checkoutLanguages).where(eq(checkoutLanguages.id, id)).get();
  if (!existing) throw new NotFoundError("Not found");

  if (data.code && data.code !== existing.code) {
    const conflict = await db.select().from(checkoutLanguages).where(and(eq(checkoutLanguages.code, data.code), sql`${checkoutLanguages.id} != ${id}`)).get();
    if (conflict) throw new ConflictError("A checkout language with this code already exists.");
  }

  if (data.isActive) {
    await db.update(checkoutLanguages).set({ isActive: false }).where(eq(checkoutLanguages.isActive, true));
  }
  if (data.isDefault) {
    await db.update(checkoutLanguages).set({ isDefault: false }).where(eq(checkoutLanguages.isDefault, true));
  }

  const updateData: Record<string, unknown> = { updatedAt: sql`(cast(strftime('%s','now') as int))` };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.code !== undefined) updateData.code = data.code;
  if (data.languageData !== undefined) updateData.languageData = JSON.stringify(data.languageData);
  if (data.fieldVisibility !== undefined) updateData.fieldVisibility = JSON.stringify(data.fieldVisibility);
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

  const [updated] = await db.update(checkoutLanguages).set(updateData).where(eq(checkoutLanguages.id, id)).returning();
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, { language: updated });
});

// PATCH /checkout-languages/:id — soft delete a checkout language
const softDeleteRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Checkout Languages"],
  summary: "Soft delete a checkout language",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: { "application/json": { schema: successEnvelope(z.object({})) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(softDeleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await db.update(checkoutLanguages).set({ deletedAt: sql`(cast(strftime('%s','now') as int))` }).where(eq(checkoutLanguages.id, id));
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, {});
});

// DELETE /checkout-languages/:id — hard delete a checkout language
const hardDeleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Checkout Languages"],
  summary: "Hard delete a checkout language",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: noContentResponse,
  }
});

adminApp.openapi(hardDeleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await db.delete(checkoutLanguages).where(eq(checkoutLanguages.id, id));
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return noContent(c);
});

// POST /checkout-languages/:id/restore — restore a soft-deleted checkout language
const restoreRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["Checkout Languages"],
  summary: "Restore a soft-deleted checkout language",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: { "application/json": { schema: successEnvelope(z.object({})) } },
    },
    ...errorResponses,
  }
});

adminApp.openapi(restoreRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  await db.update(checkoutLanguages).set({ deletedAt: null }).where(eq(checkoutLanguages.id, id));
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, {});
});

export {
  adminApp as checkoutLanguageRoutes,
  publicApp as publicCheckoutLanguageRoutes,
};
