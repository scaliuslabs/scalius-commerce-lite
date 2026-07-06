import { describe, expect, it } from "vitest";

import {
  buildMerchantReturnPolicyJsonLd,
  buildOfferShippingDetails,
  buildOnlineStoreJsonLd,
  gtinJsonLdForVariant,
  normalizeSchemaCountryCode,
  toHttpUrl,
} from "./commerce-structured-data";

describe("commerce structured data helpers", () => {
  it("builds OnlineStore identity from real business settings", () => {
    expect(
      buildOnlineStoreJsonLd({
        storefrontUrl: "https://shop.example.com",
        logoUrl: "https://shop.example.com/logo.png",
        storeName: "Fallback Store",
        business: {
          companyName: "Scalius Mart",
          legalName: "Scalius Mart Ltd.",
          addressLine1: "Road 1",
          addressLine2: "House 2",
          city: "Dhaka",
          stateRegion: "Dhaka",
          postalCode: "1207",
          country: "Bangladesh",
          phone: "+8801775528888",
          email: "support@example.com",
          taxId: "BIN-123",
        },
        social: [
          { url: "https://facebook.com/scalius" },
          { url: "mailto:support@example.com" },
        ],
      }),
    ).toMatchObject({
      "@type": "OnlineStore",
      "@id": "https://shop.example.com/#store",
      name: "Scalius Mart",
      legalName: "Scalius Mart Ltd.",
      url: "https://shop.example.com",
      address: {
        "@type": "PostalAddress",
        streetAddress: "Road 1, House 2",
        addressLocality: "Dhaka",
        addressCountry: "BD",
      },
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer service",
        areaServed: "BD",
      },
      taxID: "BIN-123",
      sameAs: ["https://facebook.com/scalius"],
    });
  });

  it("requires absolute http(s) URLs for URL-backed identity fields", () => {
    expect(toHttpUrl("mailto:support@example.com")).toBeNull();
    expect(toHttpUrl("/logo.png")).toBeNull();
    expect(toHttpUrl("https://shop.example.com/logo.png")).toBe(
      "https://shop.example.com/logo.png",
    );
    expect(
      buildOnlineStoreJsonLd({
        storefrontUrl: "https://shop.example.com",
        logoUrl: null,
        storeName: "Store",
      }),
    ).toBeNull();
  });

  it("attaches a normalized merchant return policy to OnlineStore JSON-LD", () => {
    const returnPolicy = buildMerchantReturnPolicyJsonLd({
      settings: {
        enabled: true,
        category: "finite",
        returnWindowDays: 7,
        returnFees: "customer_responsibility",
        returnMethod: "both",
        policyUrl: "/returns",
      },
      storefrontUrl: "https://shop.example.com",
      fallbackCountry: "Bangladesh",
    });

    expect(returnPolicy).toEqual({
      "@type": "MerchantReturnPolicy",
      applicableCountry: "BD",
      merchantReturnDays: 7,
      merchantReturnLink: "https://shop.example.com/returns",
      returnFees: "https://schema.org/ReturnFeesCustomerResponsibility",
      returnMethod: [
        "https://schema.org/ReturnByMail",
        "https://schema.org/ReturnInStore",
      ],
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    });
    expect(
      buildOnlineStoreJsonLd({
        storefrontUrl: "https://shop.example.com",
        logoUrl: "https://shop.example.com/logo.png",
        storeName: "Store",
        returnPolicy,
      }),
    ).toMatchObject({
      hasMerchantReturnPolicy: returnPolicy,
    });
  });

  it("builds finite-window merchant return policy schema only from complete facts", () => {
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: true,
          category: "finite_return_window",
          returnWindowDays: "14",
          returnFees: "free",
          returnMethod: "in_store",
          policyUrl: "https://shop.example.com/policies/returns",
          applicableCountry: ["bd", "NP"],
          returnPolicyCountry: "Bangladesh",
        },
        storefrontUrl: "https://shop.example.com",
      }),
    ).toEqual({
      "@type": "MerchantReturnPolicy",
      applicableCountry: ["BD", "NP"],
      merchantReturnDays: 14,
      merchantReturnLink: "https://shop.example.com/policies/returns",
      returnFees: "https://schema.org/FreeReturn",
      returnMethod: "https://schema.org/ReturnInStore",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      returnPolicyCountry: "BD",
    });
  });

  it("maps no-returns merchant policy without inventing a return window", () => {
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: true,
          category: "no_returns",
          country: "BD",
          returnFees: "free",
          returnMethod: "mail",
        },
        storefrontUrl: "https://shop.example.com",
      }),
    ).toEqual({
      "@type": "MerchantReturnPolicy",
      applicableCountry: "BD",
      returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
    });
  });

  it("returns null for disabled or incomplete merchant return policy settings", () => {
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: false,
          category: "finite",
          returnWindowDays: 14,
        },
        storefrontUrl: "https://shop.example.com",
        fallbackCountry: "Bangladesh",
      }),
    ).toBeNull();
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: true,
          category: "finite",
        },
        storefrontUrl: "https://shop.example.com",
        fallbackCountry: "Bangladesh",
      }),
    ).toBeNull();
  });

  it("filters unsafe merchant return policy URLs", () => {
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: true,
          policyUrl: "javascript:alert(1)",
        },
        storefrontUrl: "https://shop.example.com",
      }),
    ).toBeNull();
    expect(
      buildMerchantReturnPolicyJsonLd({
        settings: {
          enabled: true,
          category: "unlimited",
          policyUrl: "//evil.example/returns",
        },
        storefrontUrl: "https://shop.example.com",
        fallbackCountry: "Bangladesh",
      }),
    ).toEqual({
      "@type": "MerchantReturnPolicy",
      applicableCountry: "BD",
      returnPolicyCategory: "https://schema.org/MerchantReturnUnlimitedWindow",
    });
  });

  it("builds offer shipping details from active shipping methods", () => {
    expect(
      buildOfferShippingDetails({
        shippingMethods: [
          {
            id: "inside-dhaka",
            name: "Inside Dhaka",
            fee: 80,
            description: null,
            isActive: true,
            sortOrder: 1,
            createdAt: null,
            updatedAt: null,
          },
          {
            id: "disabled",
            name: "Disabled",
            fee: 120,
            description: null,
            isActive: false,
            sortOrder: 2,
            createdAt: null,
            updatedAt: null,
          },
        ],
        currencyCode: "BDT",
        freeDelivery: false,
        country: "Bangladesh",
      }),
    ).toEqual([
      {
        "@type": "OfferShippingDetails",
        name: "Inside Dhaka",
        shippingDestination: {
          "@type": "DefinedRegion",
          addressCountry: "BD",
        },
        shippingRate: {
          "@type": "MonetaryAmount",
          value: "80.00",
          currency: "BDT",
        },
      },
    ]);
  });

  it("uses product-level free delivery without fabricating unavailable facts", () => {
    expect(
      buildOfferShippingDetails({
        shippingMethods: [
          {
            id: "inside-dhaka",
            name: "Inside Dhaka",
            fee: 80,
            description: null,
            isActive: true,
            sortOrder: 1,
            createdAt: null,
            updatedAt: null,
          },
        ],
        currencyCode: "BDT",
        freeDelivery: true,
      })[0]?.shippingRate,
    ).toEqual({
      "@type": "MonetaryAmount",
      value: "0.00",
      currency: "BDT",
    });
  });

  it("maps only schema-safe barcode types to GTIN fields", () => {
    expect(gtinJsonLdForVariant("0123456789012", "ean13")).toEqual({
      gtin13: "0123456789012",
    });
    expect(gtinJsonLdForVariant("012345678905", "upc")).toEqual({
      gtin12: "012345678905",
    });
    expect(gtinJsonLdForVariant("9783161484100", "isbn")).toEqual({
      isbn: "9783161484100",
    });
    expect(gtinJsonLdForVariant("123", "custom")).toEqual({});
    expect(gtinJsonLdForVariant("123", null)).toEqual({});
  });

  it("normalizes Bangladesh without blocking other explicit countries", () => {
    expect(normalizeSchemaCountryCode(undefined)).toBe("BD");
    expect(normalizeSchemaCountryCode("Bangladesh")).toBe("BD");
    expect(normalizeSchemaCountryCode("NP")).toBe("NP");
  });
});
