import { Hono } from "hono";

import { checkoutLanguages } from "@scalius/database/schema";
import { eq, and, isNull, or, like, asc, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";

const app = new Hono<{ Bindings: Env }>();

app.get("/active", async (c) => {
  try {
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
      const fallbackLanguageData = {
        pageTitle: "Cart & Checkout",
        checkoutSectionTitle: "Checkout Information",
        cartSectionTitle: "Shopping Cart",
        customerNameLabel: "Full Name",
        customerNamePlaceholder: "Enter your full name",
        customerPhoneLabel: "Phone Number",
        customerPhonePlaceholder: "01XXXXXXXXX",
        customerPhoneHelp: "Example: 01712345678",
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
        requiredFieldIndicator: "*",
      };

      const fallbackFieldVisibility = {
        showEmailField: true,
        showOrderNotesField: true,
        showAreaField: true,
      };

      return c.json({
        language: {
          id: "fallback",
          name: "English (Fallback)",
          code: "en",
          languageData: fallbackLanguageData,
          fieldVisibility: fallbackFieldVisibility,
          isActive: true,
          isDefault: true,
        },
      });
    }

    const parsedLanguage = {
      ...language,
      languageData: JSON.parse(language.languageData),
      fieldVisibility: JSON.parse(language.fieldVisibility),
    };

    return c.json({ language: parsedLanguage });
  } catch (error) {
    console.error("Error fetching active checkout language:", error);
    return c.json({ error: "Failed to fetch checkout language" }, 500);
  }
});

const defaultLanguageData = {
  pageTitle: "Cart & Checkout",
  checkoutSectionTitle: "Checkout Information",
  cartSectionTitle: "Shopping Cart",
  customerNameLabel: "Full Name",
  customerNamePlaceholder: "Enter your full name",
  customerPhoneLabel: "Phone Number",
  customerPhonePlaceholder: "01XXXXXXXXX",
  customerPhoneHelp: "Example: 01712345678",
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
  requiredFieldIndicator: "*",
};

const defaultFieldVisibility = {
  showEmailField: true,
  showOrderNotesField: true,
  showAreaField: true,
};

const createCheckoutLanguageSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  code: z.string().min(1, "Code is required").max(10),
  languageData: z.object({}).passthrough().optional(),
  fieldVisibility: z.object({}).passthrough().optional(),
  isActive: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
});

const updateCheckoutLanguageSchema = createCheckoutLanguageSchema.partial();

app.get("/", async (c) => {
  const db = c.get("db");
  const q = c.req.query();
  const page = parseInt(q.page || "1");
  const limit = parseInt(q.limit || "10");
  const search = q.search || "";
  const sortField = (q.sort || "name") as keyof typeof checkoutLanguages._.columns;
  const sortOrder = (q.order || "asc") as "asc" | "desc";
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
  return c.json({
    data: results,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page < Math.ceil(total / limit),
      hasPrevPage: page > 1,
    }
  });
});

app.post("/", zValidator("json", createCheckoutLanguageSchema), async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");

  const existingLanguage = await db.select().from(checkoutLanguages).where(and(eq(checkoutLanguages.code, data.code), isNull(checkoutLanguages.deletedAt))).get();
  if (existingLanguage) return c.json({ error: "A checkout language with this code already exists." }, 409);

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
    updatedAt: sql`(cast(strftime('%s','now') as int))`,
  }).returning();

  return c.json({ data: insertedLanguage }, 201);
});

app.get("/:id", async (c) => {
  const db = c.get("db");
  const language = await db.select().from(checkoutLanguages).where(eq(checkoutLanguages.id, c.req.param("id"))).get();
  if (!language) return c.json({ error: "Not found" }, 404);
  return c.json(language);
});

app.put("/:id", zValidator("json", updateCheckoutLanguageSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const data = c.req.valid("json");

  const existing = await db.select().from(checkoutLanguages).where(eq(checkoutLanguages.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (data.code && data.code !== existing.code) {
    const conflict = await db.select().from(checkoutLanguages).where(and(eq(checkoutLanguages.code, data.code), sql`${checkoutLanguages.id} != ${id}`)).get();
    if (conflict) return c.json({ error: "A checkout language with this code already exists." }, 409);
  }

  if (data.isActive) {
    await db.update(checkoutLanguages).set({ isActive: false }).where(eq(checkoutLanguages.isActive, true));
  }
  if (data.isDefault) {
    await db.update(checkoutLanguages).set({ isDefault: false }).where(eq(checkoutLanguages.isDefault, true));
  }

  const updateData: any = { updatedAt: sql`(cast(strftime('%s','now') as int))` };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.code !== undefined) updateData.code = data.code;
  if (data.languageData !== undefined) updateData.languageData = JSON.stringify(data.languageData);
  if (data.fieldVisibility !== undefined) updateData.fieldVisibility = JSON.stringify(data.fieldVisibility);
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

  const [updated] = await db.update(checkoutLanguages).set(updateData).where(eq(checkoutLanguages.id, id)).returning();
  return c.json({ data: updated });
});

app.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  await db.update(checkoutLanguages).set({ deletedAt: sql`(cast(strftime('%s','now') as int))` }).where(eq(checkoutLanguages.id, id));
  return c.json({ success: true });
});

app.delete("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  await db.delete(checkoutLanguages).where(eq(checkoutLanguages.id, id));
  return c.body(null, 204);
});

app.post("/:id/restore", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  await db.update(checkoutLanguages).set({ deletedAt: null }).where(eq(checkoutLanguages.id, id));
  return c.json({ success: true });
});

export { app as checkoutLanguageRoutes };
