import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import { checkoutLanguages } from "@scalius/database/schema";
import { eq, and, isNull, or, like, asc, desc, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NotFoundError, ConflictError } from "../utils/api-error";

import { ok, created, noContent } from "../utils/api-response";
import { successEnvelope, noContentResponse, errorResponses, conflictResponse } from "../schemas/responses";
import { optionalNullableTimestampSchema, optionalTimestampSchema } from "../schemas/timestamps";
import { invalidateApiAndScheduleStorefrontGroups } from "../utils/cache-invalidation";

const CHECKOUT_CACHE_GROUPS = ["checkout"] as const;
const CHECKOUT_LANGUAGE_TRANSITION_TARGET_MISSING =
  "CHECKOUT_LANGUAGE_TRANSITION_TARGET_MISSING";

const publicApp = new OpenAPIHono<{ Bindings: Env }>();
const adminApp = new OpenAPIHono<{ Bindings: Env }>();

const checkoutLanguageCreateErrorResponses = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  409: conflictResponse,
  500: errorResponses[500],
} as const;

const checkoutLanguageUpdateErrorResponses = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  500: errorResponses[500],
} as const;

const checkoutLanguageSideEffectErrorResponses = {
  401: errorResponses[401],
  403: errorResponses[403],
  500: errorResponses[500],
} as const;

const checkoutLanguageShortTextSchema = z.string().max(80);
const checkoutLanguageDataSchema = z.object({
  pageTitle: checkoutLanguageShortTextSchema,
  checkoutSectionTitle: checkoutLanguageShortTextSchema,
  cartSectionTitle: checkoutLanguageShortTextSchema,
  customerNameLabel: checkoutLanguageShortTextSchema,
  customerNamePlaceholder: checkoutLanguageShortTextSchema,
  customerPhoneLabel: checkoutLanguageShortTextSchema,
  customerPhonePlaceholder: checkoutLanguageShortTextSchema,
  customerPhoneHelp: checkoutLanguageShortTextSchema,
  customerEmailLabel: checkoutLanguageShortTextSchema,
  customerEmailPlaceholder: checkoutLanguageShortTextSchema,
  shippingAddressLabel: checkoutLanguageShortTextSchema,
  shippingAddressPlaceholder: checkoutLanguageShortTextSchema,
  cityLabel: checkoutLanguageShortTextSchema,
  zoneLabel: checkoutLanguageShortTextSchema,
  areaLabel: checkoutLanguageShortTextSchema,
  shippingMethodLabel: checkoutLanguageShortTextSchema,
  orderNotesLabel: checkoutLanguageShortTextSchema,
  orderNotesPlaceholder: checkoutLanguageShortTextSchema,
  continueShoppingText: checkoutLanguageShortTextSchema,
  subtotalText: checkoutLanguageShortTextSchema,
  shippingText: checkoutLanguageShortTextSchema,
  discountText: checkoutLanguageShortTextSchema,
  totalText: checkoutLanguageShortTextSchema,
  discountCodePlaceholder: checkoutLanguageShortTextSchema,
  applyDiscountText: checkoutLanguageShortTextSchema,
  removeDiscountText: checkoutLanguageShortTextSchema,
  placeOrderText: checkoutLanguageShortTextSchema,
  processingText: checkoutLanguageShortTextSchema,
  emptyCartText: checkoutLanguageShortTextSchema,
  termsText: z.string().max(1_000),
  processingOrderTitle: checkoutLanguageShortTextSchema,
  processingOrderMessage: z.string().max(500),
  requiredFieldIndicator: checkoutLanguageShortTextSchema,
});
const checkoutLanguageFieldVisibilitySchema = z.object({
  showEmailField: z.boolean(),
  showOrderNotesField: z.boolean(),
  showAreaField: z.boolean(),
});

const checkoutLanguageSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(100),
  code: z.string().max(10),
  languageData: checkoutLanguageDataSchema,
  fieldVisibility: checkoutLanguageFieldVisibilitySchema,
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: optionalTimestampSchema,
  updatedAt: optionalTimestampSchema,
  deletedAt: optionalNullableTimestampSchema,
});

const publicCheckoutLanguageSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  languageData: checkoutLanguageDataSchema,
  fieldVisibility: checkoutLanguageFieldVisibilitySchema,
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: optionalTimestampSchema,
  updatedAt: optionalTimestampSchema,
  deletedAt: optionalNullableTimestampSchema,
});

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

function parseStoredObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function publicCheckoutLanguageProjection(languageData: unknown, fieldVisibility: unknown) {
  const storedLanguageData = parseStoredObject(languageData);
  const storedFieldVisibility = parseStoredObject(fieldVisibility);
  const projectedLanguageData = { ...defaultLanguageData };
  for (const key of Object.keys(projectedLanguageData) as Array<keyof typeof projectedLanguageData>) {
    const value = storedLanguageData[key];
    if (typeof value !== "string") continue;
    const maximumLength = key === "termsText"
      ? 1_000
      : key === "processingOrderMessage"
        ? 500
        : 80;
    projectedLanguageData[key] = value.slice(0, maximumLength);
  }
  const projectedFieldVisibility = { ...defaultFieldVisibility };
  for (const key of Object.keys(projectedFieldVisibility) as Array<keyof typeof projectedFieldVisibility>) {
    const value = storedFieldVisibility[key];
    if (typeof value === "boolean") projectedFieldVisibility[key] = value;
  }
  return {
    languageData: projectedLanguageData,
    fieldVisibility: projectedFieldVisibility,
  };
}

const createCheckoutLanguageSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).openapi({ description: "Language name" }),
  code: z.string().min(1, "Code is required").max(10).openapi({ description: "Language code" }),
  languageData: checkoutLanguageDataSchema.partial().optional().openapi({ description: "Language strings" }),
  fieldVisibility: checkoutLanguageFieldVisibilitySchema.partial().optional().openapi({ description: "Field visibility settings" }),
  isActive: z.boolean().optional().default(false).openapi({ description: "Whether this language is active" }),
  isDefault: z.boolean().optional().default(false).openapi({ description: "Whether this is the default language" })
});

const updateCheckoutLanguageSchema = createCheckoutLanguageSchema.partial();

function checkoutLanguageConstraintText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);

  const candidate = error as {
    message?: unknown;
    detail?: unknown;
    cause?: unknown;
  };
  return [
    candidate.message,
    candidate.detail,
    checkoutLanguageConstraintText(candidate.cause, depth + 1),
  ].filter((value): value is string => typeof value === "string")
    .join(" ");
}

function rethrowCheckoutLanguageConstraint(error: unknown): never {
  const message = checkoutLanguageConstraintText(error);
  if (
    /checkout_languages_code_unique|unique constraint failed:\s*checkout_languages\.code|unique constraint.*checkout_languages.*code/i
      .test(message)
  ) {
    throw new ConflictError("A checkout language with this code already exists.");
  }
  if (
    /checkout_languages_one_(?:active|default)_idx|unique constraint failed:\s*checkout_languages\.is_(?:active|default)/i
      .test(message)
  ) {
    throw new ConflictError(
      "Another checkout language selection was saved at the same time. Reload and try again.",
    );
  }
  throw error;
}

// GET /checkout-languages/active — get active checkout language
const publicGetActiveRoute = createRoute({
  method: "get",
  path: "/active",
  operationId: "storefront.checkout_language.get_active",
  tags: ["Checkout Languages"],
  summary: "Get active checkout language",
  responses: {
    200: {
      description: "Active checkout language",
      content: { "application/json": { schema: successEnvelope(z.object({ language: publicCheckoutLanguageSchema })) } },
    },
    ...errorResponses,
  }
});

const adminGetActiveRoute = createRoute({
  method: "get",
  path: "/active",
  operationId: "dashboard.checkout_languages.active_get",
  tags: ["Checkout Languages"],
  summary: "Get active checkout language",
  responses: publicGetActiveRoute.responses,
});

async function getActiveCheckoutLanguage(db: Database) {
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

    return {
      language: {
        id: "fallback",
        name: "English (Fallback)",
        code: "en",
        languageData: defaultLanguageData,
        fieldVisibility: fallbackFieldVisibility,
        isActive: true,
        isDefault: true
      }
    };
  }

  const parsedLanguage = {
    ...language,
    ...publicCheckoutLanguageProjection(language.languageData, language.fieldVisibility),
  };

  return { language: parsedLanguage };
}

publicApp.openapi(publicGetActiveRoute, async (c) =>
  ok(c, await getActiveCheckoutLanguage(c.get("db"))));
adminApp.openapi(adminGetActiveRoute, async (c) =>
  ok(c, await getActiveCheckoutLanguage(c.get("db"))));

// GET /checkout-languages — list all checkout languages
const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.checkout_languages.list",
  tags: ["Checkout Languages"],
  summary: "List all checkout languages with pagination",
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).max(1_000_000).optional().default(1).openapi({ description: "Page number" }),
      limit: z.coerce.number().int().min(1).max(10).optional().default(10).openapi({ description: "Items per page" }),
      search: z.string().max(100).optional().default("").openapi({ description: "Search query" }),
      sort: z.enum(["name", "code", "isActive", "isDefault", "createdAt", "updatedAt"]).optional().default("name").openapi({ description: "Sort field" }),
      order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
      trashed: z.enum(["true", "false"]).optional().default("false").openapi({ description: "Show trashed items" })
    })
  },
  responses: {
    200: {
      description: "Checkout language list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({ languages: z.array(checkoutLanguageSchema).max(10), pagination: z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number(), hasNextPage: z.boolean(), hasPrevPage: z.boolean() }) })) } },
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
    languages: results.map((language) => ({
      ...language,
      ...publicCheckoutLanguageProjection(
        language.languageData,
        language.fieldVisibility,
      ),
    })),
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
  operationId: "dashboard.checkout_languages.create",
  tags: ["Checkout Languages"],
  summary: "Create a new checkout language",
  request: {
    body: {
      required: true,
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
    ...checkoutLanguageCreateErrorResponses,
  }
});

adminApp.openapi(createRoute2, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");

  const existingLanguage = await db.select().from(checkoutLanguages).where(and(eq(checkoutLanguages.code, data.code), isNull(checkoutLanguages.deletedAt))).get();
  if (existingLanguage) {
    throw new ConflictError("A checkout language with this code already exists.");
  }

  const newLanguageId = "cl_" + nanoid();
  const insertStatement = db.insert(checkoutLanguages).values({
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

  let insertedLanguage: typeof checkoutLanguages.$inferSelect | undefined;
  try {
    if (data.isActive || data.isDefault) {
      const resetValues: Partial<typeof checkoutLanguages.$inferInsert> = {};
      const resetConditions = [];
      if (data.isActive) {
        resetValues.isActive = false;
        resetConditions.push(eq(checkoutLanguages.isActive, true));
      }
      if (data.isDefault) {
        resetValues.isDefault = false;
        resetConditions.push(eq(checkoutLanguages.isDefault, true));
      }
      const [, insertedRows] = await safeBatch(db, [
        db.update(checkoutLanguages)
          .set(resetValues)
          .where(or(...resetConditions)),
        insertStatement,
      ] as const);
      insertedLanguage = insertedRows[0];
    } else {
      [insertedLanguage] = await insertStatement;
    }
  } catch (error) {
    rethrowCheckoutLanguageConstraint(error);
  }

  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return created(c, {
    language: insertedLanguage
      ? {
          ...insertedLanguage,
          ...publicCheckoutLanguageProjection(
            insertedLanguage.languageData,
            insertedLanguage.fieldVisibility,
          ),
        }
      : undefined,
  });
});

// GET /checkout-languages/:id — get checkout language by ID
const getByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "dashboard.checkout_languages.get",
  tags: ["Checkout Languages"],
  summary: "Get checkout language by ID",
  request: {
    params: z.object({
      id: z.string().max(64),
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
  return ok(c, {
    ...language,
    ...publicCheckoutLanguageProjection(
      language.languageData,
      language.fieldVisibility,
    ),
  });
});

// PUT /checkout-languages/:id — update a checkout language
const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "dashboard.checkout_languages.update",
  tags: ["Checkout Languages"],
  summary: "Update a checkout language",
  request: {
    params: z.object({
      id: z.string().max(64),
    }),
    body: {
      required: true,
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
    ...checkoutLanguageUpdateErrorResponses,
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

  const updateData: Record<string, unknown> = { updatedAt: sql`(cast(strftime('%s','now') as int))` };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.code !== undefined) updateData.code = data.code;
  if (data.languageData !== undefined) updateData.languageData = JSON.stringify(data.languageData);
  if (data.fieldVisibility !== undefined) updateData.fieldVisibility = JSON.stringify(data.fieldVisibility);
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

  const updateStatement = db.update(checkoutLanguages)
    .set(updateData)
    .where(eq(checkoutLanguages.id, id))
    .returning();
  let updated: typeof checkoutLanguages.$inferSelect | undefined;
  try {
    if (data.isActive || data.isDefault) {
      const resetValues: Partial<typeof checkoutLanguages.$inferInsert> = {};
      const resetConditions = [];
      if (data.isActive) {
        resetValues.isActive = false;
        resetConditions.push(eq(checkoutLanguages.isActive, true));
      }
      if (data.isDefault) {
        resetValues.isDefault = false;
        resetConditions.push(eq(checkoutLanguages.isDefault, true));
      }
      const [, , updatedRows] = await safeBatch(db, [
        buildBatchGuard(
          db,
          sql`EXISTS (SELECT 1 FROM ${checkoutLanguages} WHERE ${checkoutLanguages.id} = ${id})`,
          CHECKOUT_LANGUAGE_TRANSITION_TARGET_MISSING,
        ),
        db.update(checkoutLanguages)
          .set(resetValues)
          .where(and(
            ne(checkoutLanguages.id, id),
            or(...resetConditions),
          )),
        updateStatement,
      ] as const);
      updated = updatedRows[0];
    } else {
      [updated] = await updateStatement;
    }
  } catch (error) {
    if (isBatchGuardError(
      error,
      CHECKOUT_LANGUAGE_TRANSITION_TARGET_MISSING,
    )) {
      throw new NotFoundError("Not found");
    }
    rethrowCheckoutLanguageConstraint(error);
  }
  if (!updated) throw new NotFoundError("Not found");
  await invalidateApiAndScheduleStorefrontGroups(CHECKOUT_CACHE_GROUPS, c);
  return ok(c, {
    language: {
      ...updated,
      ...publicCheckoutLanguageProjection(
        updated.languageData,
        updated.fieldVisibility,
      ),
    },
  });
});

// PATCH /checkout-languages/:id — soft delete a checkout language
const softDeleteRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "dashboard.checkout_languages.trash",
  tags: ["Checkout Languages"],
  summary: "Soft delete a checkout language",
  request: {
    params: z.object({
      id: z.string().max(64),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: { "application/json": { schema: successEnvelope(z.object({})) } },
    },
    ...checkoutLanguageSideEffectErrorResponses,
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
  operationId: "dashboard.checkout_languages.delete_permanently",
  tags: ["Checkout Languages"],
  summary: "Hard delete a checkout language",
  request: {
    params: z.object({
      id: z.string().max(64),
    }),
  },
  responses: {
    204: noContentResponse,
    ...checkoutLanguageSideEffectErrorResponses,
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
  operationId: "dashboard.checkout_languages.restore",
  tags: ["Checkout Languages"],
  summary: "Restore a soft-deleted checkout language",
  request: {
    params: z.object({
      id: z.string().max(64),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: { "application/json": { schema: successEnvelope(z.object({})) } },
    },
    ...checkoutLanguageSideEffectErrorResponses,
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
