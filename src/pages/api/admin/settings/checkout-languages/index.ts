import type { APIRoute } from "astro";
import { db } from "@/db";
import { checkoutLanguages } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql, eq, and, or, isNull, like, asc, desc } from "drizzle-orm";
import { z } from "zod";

// Default language data structure
const defaultLanguageData = {
  // Page titles and headers
  pageTitle: "Cart & Checkout",
  checkoutSectionTitle: "Checkout Information",
  cartSectionTitle: "Shopping Cart",

  // Form field labels
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

  // Cart section labels
  continueShoppingText: "Continue Shopping",
  subtotalText: "Subtotal",
  shippingText: "Shipping",
  discountText: "Discount",
  totalText: "Total",

  // Discount section
  discountCodePlaceholder: "Discount code",
  applyDiscountText: "Apply",
  removeDiscountText: "Remove",

  // Buttons and actions
  placeOrderText: "Place Order",
  processingText: "Processing...",

  // Messages and notifications
  emptyCartText: "Your cart is empty",
  termsText:
    "By placing this order, you agree to our Terms of Service and Privacy Policy",

  // Loading overlay
  processingOrderTitle: "Processing Your Order",
  processingOrderMessage: "Please wait while we process your order.",

  // Required field indicators
  requiredFieldIndicator: "*",
};

const defaultFieldVisibility = {
  showEmailField: true,
  showOrderNotesField: true,
  showAreaField: true,
};

// Zod schema for creating a checkout language
const createCheckoutLanguageSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  code: z.string().min(1, "Code is required").max(10),
  languageData: z.object({}).passthrough().optional(),
  fieldVisibility: z.object({}).passthrough().optional(),
  isActive: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
});

// GET: List all checkout languages
export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const search = searchParams.get("search") || "";
    const sortField = (searchParams.get("sort") || "name") as
      | "name"
      | "code"
      | "isActive"
      | "isDefault"
      | "createdAt"
      | "updatedAt";
    const sortOrder = (searchParams.get("order") || "asc") as "asc" | "desc";
    const showTrashed = searchParams.get("trashed") === "true";

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

    const combinedWhereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const results = await db
      .select()
      .from(checkoutLanguages)
      .where(combinedWhereClause)
      .orderBy(
        sortOrder === "asc"
          ? asc(checkoutLanguages[sortField])
          : desc(checkoutLanguages[sortField]),
      )
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(checkoutLanguages)
      .where(combinedWhereClause)
      .get();

    const total = countResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    return new Response(
      JSON.stringify({
        data: results,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching checkout languages:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch checkout languages" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// POST: Create a new checkout language
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const validation = createCheckoutLanguageSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid input",
          details: validation.error.flatten(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const { name, code, languageData, fieldVisibility, isActive, isDefault } =
      validation.data;

    // Check if code already exists (and is not deleted)
    const existingLanguage = await db
      .select()
      .from(checkoutLanguages)
      .where(
        and(
          eq(checkoutLanguages.code, code),
          isNull(checkoutLanguages.deletedAt),
        ),
      )
      .get();
    if (existingLanguage) {
      return new Response(
        JSON.stringify({
          error: "A checkout language with this code already exists.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    // If setting as active, deactivate all others
    if (isActive) {
      await db
        .update(checkoutLanguages)
        .set({ isActive: false })
        .where(eq(checkoutLanguages.isActive, true));
    }

    // If setting as default, remove default from all others
    if (isDefault) {
      await db
        .update(checkoutLanguages)
        .set({ isDefault: false })
        .where(eq(checkoutLanguages.isDefault, true));
    }

    const newLanguageId = "cl_" + nanoid();
    const [insertedLanguage] = await db
      .insert(checkoutLanguages)
      .values({
        id: newLanguageId,
        name,
        code,
        languageData: JSON.stringify(languageData || defaultLanguageData),
        fieldVisibility: JSON.stringify(
          fieldVisibility || defaultFieldVisibility,
        ),
        isActive: isActive || false,
        isDefault: isDefault || false,
        createdAt: sql`(cast(strftime('%s','now') as int))`,
        updatedAt: sql`(cast(strftime('%s','now') as int))`,
      })
      .returning();

    return new Response(JSON.stringify({ data: insertedLanguage }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating checkout language:", error);
    // Check for unique constraint violation on code (SQLite specific)
    if (
      error instanceof Error &&
      error.message.includes(
        "UNIQUE constraint failed: checkout_languages.code",
      )
    ) {
      return new Response(
        JSON.stringify({
          error: "A checkout language with this code already exists.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "Failed to create checkout language" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
