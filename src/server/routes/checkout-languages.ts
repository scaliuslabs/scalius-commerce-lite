import { Hono } from "hono";

import { checkoutLanguages } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

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

export { app as checkoutLanguageRoutes };
