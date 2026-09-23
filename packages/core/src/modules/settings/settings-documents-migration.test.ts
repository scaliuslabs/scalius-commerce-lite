// The 0065 data migration moves every legacy settings shape (per-key rows,
// the site_settings singleton, meta_conversions_settings, pre-document rows)
// into one document row each. These fixtures are populated on the 0064 schema,
// migrated, then read back through the same services the Workers use.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { parseSeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { parseSeoReturnPolicySettings } from "@scalius/shared/seo-return-policy";
import {
  getCustomerAuthPolicyForMethod,
  getLegacyCustomerAuthMethodForPolicy,
} from "@scalius/shared/customer-auth-policy";

import { encodeEncryptedCredential, encryptCredentials } from "../../utils/credential-encryption";
import { getEmailRuntimeSettings } from "../../integrations/email/settings";
import { readFirebaseSettings } from "../../integrations/firebase/settings";
import { getSmsSettings } from "../../integrations/sms/sms-settings";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { getCapiSettings } from "../analytics/meta.service";
import {
  getPaymentMethodPreferences,
  getSSLCommerzSettings,
  getStripeSettings,
} from "../payments/gateway-settings";
import { getBusinessSettings } from "./business-settings.service";
import { getCheckoutFlowSettingsDocument } from "./checkout-flow-admin.service";
import { getCustomerRequestPolicy } from "./customer-request-policy";
import { customerAuthDocument, securityDocument } from "./documents";
import { getPlatformSettings } from "./platform-settings.service";
import {
  getAdminNotificationChannels,
  getNotificationChannels,
  getOrderWhatsAppTemplateSettings,
} from "./settings.service";
import {
  getAllowedCountries,
  getCurrencySettings,
  getGeneralSettings,
  getHomepagePresentationSettings,
  getMediaOptimizationSettings,
  getSeoSettings,
} from "./site-settings.service";

const KEY = Buffer.alloc(32, 7).toString("base64");
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../../../database/migrations");
const DOCUMENT_MIGRATION = "0067_settings_documents.sql";

type Provider = "d1" | "turso";

function migrationFiles(): string[] {
  return readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function migrateUpTo(sqlite: DatabaseSync, provider: Provider, predicate: (name: string) => boolean) {
  for (const name of migrationFiles().filter(predicate)) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(join(migrationDirectory, name), "utf8"), provider));
  }
}

async function enc(value: string): Promise<string> {
  return encodeEncryptedCredential(await encryptCredentials(value, KEY));
}

function insertSetting(sqlite: DatabaseSync, category: string, key: string, value: string) {
  sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, ?, ?, 'string', ?)")
    .run(crypto.randomUUID(), key, value, category);
}

interface SiteRow {
  whatsappAccessToken: string | null;
}

function insertSiteSettings(sqlite: DatabaseSync, row: SiteRow) {
  sqlite.prepare(`INSERT INTO site_settings (
      id, site_name, header_config, header_config_revision, footer_config, footer_config_revision,
      homepage_config, homepage_config_revision, site_title, homepage_title, homepage_meta_description,
      robots_txt, storefront_url, auth_verification_method, guest_checkout_enabled, checkout_mode,
      partial_payment_enabled, partial_payment_amount, checkout_flow_revision,
      whatsapp_access_token, whatsapp_phone_number_id, whatsapp_template_name
    ) VALUES (
      'settings_1', 'My Store',
      '{"logo":{"src":"media/logo.png","alt":"Shop"},"navigation":[{"id":"legacy"}]}', 4,
      '{"tagline":"Made nearby"}', 2,
      '{"categoryRail":{"enabled":true,"title":"Shop by category","categoryIds":["cat_1"]},"trustStrip":{"enabled":false}}', 3,
      'Shop', 'Home', 'Everything nearby', 'User-agent: *', 'https://shop.example.com', 'sms_otp',
      0, 'gateways_only', 1, 250, 7, ?, '109876543210987', 'otp_login'
    )`).run(row.whatsappAccessToken);
}

async function populateCommon(sqlite: DatabaseSync) {
  insertSetting(sqlite, "business_info", "company_name", "Shop Ltd");
  insertSetting(sqlite, "business_info", "invoice_prefix", "SL");
  insertSetting(sqlite, "business_info", "invoice_logo_url", "media/invoice.png");
  insertSetting(sqlite, "currency", "currency_code", "USD");
  insertSetting(sqlite, "currency", "currency_symbol", "$");
  insertSetting(sqlite, "currency", "usd_exchange_rate", "1");
  insertSetting(sqlite, "notifications", "order_channels", JSON.stringify({
    channels: { order_created: { email: true, sms: true }, order_shipped: ["whatsapp", "pigeon"] },
  }));
  insertSetting(sqlite, "notifications", "admin_channels", JSON.stringify({ order_created: [] }));
  insertSetting(sqlite, "notifications", "whatsapp_order_template_name", "order_update");
  insertSetting(sqlite, "notifications", "whatsapp_order_template_language", "bn");
  insertSetting(sqlite, "order_support", "customer_request_policy", JSON.stringify({
    cancellationEnabled: false,
    returnEnabled: true,
    refundEnabled: true,
    visibility: "show_unavailable",
    introText: "Need help?",
  }));
  insertSetting(sqlite, "seo", "discovery", JSON.stringify({ sitemap: { products: false }, feeds: { title: "Feed" } }));
  insertSetting(sqlite, "seo", "return_policy", JSON.stringify({
    enabled: true,
    category: "finite",
    returnWindowDays: 14,
    returnFees: "free",
    returnMethod: "by_mail",
    country: "BD",
  }));
  insertSetting(sqlite, "sms", "active_provider", "smsnetbd");
  insertSetting(sqlite, "sms", "smsnetbd_api_key", await enc("sms-live-key-8841"));
  insertSetting(sqlite, "sms", "smsnetbd_sender_id", "SHOP");
  insertSetting(sqlite, "theme", "storefront_colors", JSON.stringify({ primary: "#047857" }));
  insertSetting(sqlite, "polar", "access_token", "stale");
  insertSetting(sqlite, "notification_provider_health", "sms:smsnetbd", "{\"blockedUntil\":1}");
  sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('fraud_1', 'provider_1', 'ciphertext', 'json', 'fraud-checker')").run();
}

/** A store that already ran the pre-0065 documents (platform/email/firebase/WhatsApp token/security/media). */
async function populateDocumentEra(sqlite: DatabaseSync) {
  insertSiteSettings(sqlite, { whatsappAccessToken: null });
  await populateCommon(sqlite);
  insertSetting(sqlite, "platform", "config", JSON.stringify({
    apiUrl: "https://api.shop.example.com",
    dashboardUrl: "https://admin.shop.example.com",
    mediaUrl: "https://cdn.shop.example.com",
    customerAuthCookieDomain: "shop.example.com",
    corsAllowedOrigins: ["https://partner.example.com"],
    setupTokenRequired: true,
  }));
  insertSetting(sqlite, "security", "csp_allowed_domains", "https://analytics.example.com,https://*.cdn.example.com");
  insertSetting(sqlite, "media", "image_optimization", JSON.stringify({
    canonicalCdnUrl: "cdn.shop.example.com",
    canonicalHostAliases: ["old.shop.example.com"],
  }));
  insertSetting(sqlite, "email", "config", JSON.stringify({
    provider: "resend",
    sender: "shop@example.com",
    resendApiKey: await enc("re_live_123"),
  }));
  insertSetting(sqlite, "firebase", "config", JSON.stringify({
    serviceAccount: await enc(JSON.stringify({ client_email: "a@b.iam", private_key: "k", project_id: "p" })),
    publicConfig: { apiKey: "public-key" },
  }));
  insertSetting(sqlite, "whatsapp", "access_token", await enc("EAAG-live-token"));
  insertSetting(sqlite, "phone", "allowed_countries", JSON.stringify({ countries: ["BD", "IN"], mode: "exclude" }));
  insertSetting(sqlite, "customer_auth", "policy", JSON.stringify({ otpChannels: ["sms", "whatsapp"], defaultOtpChannel: "sms" }));
  insertSetting(sqlite, "stripe", "secret_key", await enc("sk_test_51shop"));
  insertSetting(sqlite, "stripe", "publishable_key", "pk_test_51shop");
  insertSetting(sqlite, "stripe", "webhook_secret", await enc("whsec_shop"));
  insertSetting(sqlite, "stripe", "enabled", "true");
  insertSetting(sqlite, "sslcommerz", "store_id", "shop01");
  insertSetting(sqlite, "sslcommerz", "store_password", await enc("store-pass-xyz"));
  insertSetting(sqlite, "sslcommerz", "sandbox", "false");
  insertSetting(sqlite, "sslcommerz", "enabled", "false");
  insertSetting(sqlite, "payment_methods", "enabled_methods", JSON.stringify(["cod", "stripe"]));
  insertSetting(sqlite, "payment_methods", "default_method", "stripe");
  sqlite.prepare(`INSERT INTO meta_conversions_settings
      (id, pixel_id, access_token, test_event_code, is_enabled, log_retention_days)
      VALUES ('singleton', '123456789012345', ?, 'TEST1', 1, 7)`)
    .run(await encryptCredentials("meta-token", KEY));
}

/** A store whose settings predate every document (per-key rows, plaintext WhatsApp token). */
async function populateLegacyEra(sqlite: DatabaseSync) {
  insertSiteSettings(sqlite, { whatsappAccessToken: " EAAG-plain-token " });
  await populateCommon(sqlite);
  insertSetting(sqlite, "platform", "api_url", "https://api.shop.example.com");
  insertSetting(sqlite, "platform", "cors_allowed_origins", "https://a.example.com, https://b.example.com");
  insertSetting(sqlite, "email", "email_provider", "cloudflare");
  insertSetting(sqlite, "email", "email_sender", " ops@example.com ");
  insertSetting(sqlite, "firebase", "public_config", JSON.stringify({ projectId: "legacy" }));
  insertSetting(sqlite, "phone", "allowed_countries", JSON.stringify(["BD"]));
  insertSetting(sqlite, "stripe", "secret_key", await enc("sk_test_51shop"));
  insertSetting(sqlite, "stripe", "publishable_key", "pk_test_51shop");
  insertSetting(sqlite, "stripe", "webhook_secret", await enc("whsec_shop"));
  insertSetting(sqlite, "payment_methods", "default_method", "cod");
}

function migrated(provider: Provider, populate: (sqlite: DatabaseSync) => Promise<void>) {
  return async () => {
    const sqlite = new DatabaseSync(":memory:");
    migrateUpTo(sqlite, provider, (name) => name < DOCUMENT_MIGRATION);
    await populate(sqlite);
    migrateUpTo(sqlite, provider, (name) => name >= DOCUMENT_MIGRATION);
    return createSqliteD1Database({ sqlite });
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["d1", "turso"] as const)("0065 settings documents migration (%s)", (provider) => {
  it("keeps every document-era setting identical", async () => {
    const { db, sqlite } = await migrated(provider, populateDocumentEra)();

    expect(await getPlatformSettings(db)).toMatchObject({
      storefrontUrl: "https://shop.example.com",
      apiUrl: "https://api.shop.example.com",
      dashboardUrl: "https://admin.shop.example.com",
      mediaUrl: "https://cdn.shop.example.com",
      customerAuthCookieDomain: "shop.example.com",
      corsAllowedOrigins: ["https://partner.example.com"],
      setupTokenRequired: true,
    });
    expect((await securityDocument.read(db)).cspAllowedDomains)
      .toBe("https://analytics.example.com,https://*.cdn.example.com");
    expect(await getMediaOptimizationSettings(db)).toEqual({
      canonicalCdnUrl: "cdn.shop.example.com",
      canonicalHostAliases: ["old.shop.example.com"],
    });
    expect(await getEmailRuntimeSettings({ db, encryptionKey: KEY })).toMatchObject({
      provider: "resend",
      sender: "shop@example.com",
      resendApiKey: "re_live_123",
    });
    expect(await readFirebaseSettings(db, KEY)).toMatchObject({
      serviceAccountStored: true,
      publicConfig: { apiKey: "public-key" },
    });
    expect((await readFirebaseSettings(db, KEY)).serviceAccountJson).toContain("a@b.iam");
    expect(await getWhatsAppCloudApiSettings(db, KEY)).toEqual({
      accessToken: "EAAG-live-token",
      accessTokenConfigured: true,
      phoneNumberId: "109876543210987",
      authTemplateName: "otp_login",
    });
    expect(await getAllowedCountries(db)).toEqual({ allowedCountries: ["BD", "IN"], allowedCountriesMode: "exclude" });
    // A stored policy wins; the legacy method is derived from it, as before.
    expect(await customerAuthDocument.read(db)).toEqual({
      authVerificationMethod: getLegacyCustomerAuthMethodForPolicy({ otpChannels: ["sms", "whatsapp"] }),
      policy: expect.objectContaining({ otpChannels: ["sms", "whatsapp"], defaultOtpChannel: "sms" }),
    });
    expect(await getStripeSettings(db, KEY)).toEqual({
      secretKey: "sk_test_51shop",
      publishableKey: "pk_test_51shop",
      webhookSecret: "whsec_shop",
      enabled: true,
      credentialErrors: [],
    });
    expect(await getSSLCommerzSettings(db, KEY)).toEqual({
      storeId: "shop01",
      storePassword: "store-pass-xyz",
      sandbox: false,
      enabled: false,
      credentialErrors: [],
    });
    expect(await getPaymentMethodPreferences(db)).toEqual({
      enabledMethods: ["cod", "stripe"],
      defaultMethod: "stripe",
      hasExplicitEnabledMethods: true,
    });
    expect(await getCapiSettings(db, KEY)).toEqual({
      pixelId: "123456789012345",
      accessToken: "meta-token",
      testEventCode: "TEST1",
      isEnabled: true,
      logRetentionDays: 7,
    });
    await expectCommonSettings(db);
    expectOnlyDocumentRows(sqlite);
  });

  it("assembles pre-document rows into documents", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, sqlite } = await migrated(provider, populateLegacyEra)();

    expect(await getPlatformSettings(db)).toMatchObject({
      storefrontUrl: "https://shop.example.com",
      apiUrl: "https://api.shop.example.com",
      dashboardUrl: "",
      corsAllowedOrigins: ["https://a.example.com", "https://b.example.com"],
      setupTokenRequired: false,
    });
    expect(await getEmailRuntimeSettings({ db, encryptionKey: KEY })).toMatchObject({
      provider: "cloudflare",
      sender: "ops@example.com",
      resendApiKey: null,
    });
    expect(await readFirebaseSettings(db, KEY)).toEqual({
      serviceAccountStored: false,
      serviceAccountJson: undefined,
      publicConfig: { projectId: "legacy" },
    });
    // The pre-encryption plaintext token stays readable until the next save.
    expect((await getWhatsAppCloudApiSettings(db, KEY)).accessToken).toBe("EAAG-plain-token");
    expect(await getAllowedCountries(db)).toEqual({ allowedCountries: ["BD"], allowedCountriesMode: "include" });
    expect(await customerAuthDocument.read(db)).toEqual({
      authVerificationMethod: "sms_otp",
      policy: getCustomerAuthPolicyForMethod("sms_otp"),
    });
    // All keys and no saved switch: the dashboard showed Stripe enabled.
    expect((await getStripeSettings(db, KEY))?.enabled).toBe(true);
    expect(await getSSLCommerzSettings(db, KEY)).toBeNull();
    expect(await getPaymentMethodPreferences(db)).toEqual({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
      hasExplicitEnabledMethods: false,
    });
    expect(await getCapiSettings(db, KEY)).toBeNull();
    await expectCommonSettings(db);
    expectOnlyDocumentRows(sqlite);
  });

  it("migrates an empty store to defaults without inventing documents", async () => {
    const { db, sqlite } = await migrated(provider, async () => undefined)();
    expect(sqlite.prepare("SELECT count(*) AS count FROM settings").get()).toEqual({ count: 0 });
    expect(await getCheckoutFlowSettingsDocument(db)).toEqual({
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      revision: 0,
    });
    expect(await getCurrencySettings(db)).toEqual({ currencyCode: "BDT", currencySymbol: "৳", usdExchangeRate: "1" });
  });
});

async function expectCommonSettings(db: Parameters<typeof getBusinessSettings>[0]) {
  expect(await getBusinessSettings(db)).toMatchObject({
    companyName: "Shop Ltd",
    country: "Bangladesh",
    invoicePrefix: "SL",
    invoiceLogoUrl: "media/invoice.png",
  });
  expect(await getCurrencySettings(db)).toEqual({ currencyCode: "USD", currencySymbol: "$", usdExchangeRate: "1" });
  expect(await getCheckoutFlowSettingsDocument(db)).toEqual({
    guestCheckoutEnabled: false,
    checkoutMode: "gateways_only",
    partialPaymentEnabled: true,
    partialPaymentAmount: 250,
    revision: 7,
  });
  expect(await getCustomerRequestPolicy(db)).toEqual({
    cancellationEnabled: false,
    returnEnabled: true,
    refundEnabled: true,
    visibility: "show_unavailable",
    introText: "Need help?",
  });
  const general = await getGeneralSettings(db);
  expect(general.headerConfig).toEqual({ logo: { src: "media/logo.png", alt: "Shop" } });
  expect(general.footerConfig).toEqual({ tagline: "Made nearby" });
  expect(general.revisions).toEqual({ header: 4, footer: 2 });
  expect(await getHomepagePresentationSettings(db)).toMatchObject({
    revision: 3,
    config: { categoryRail: { enabled: true, title: "Shop by category", categoryIds: ["cat_1"] } },
  });
  expect(await getSeoSettings(db)).toEqual({
    homepageTitle: "Home",
    homepageMetaDescription: "Everything nearby",
    socialImage: "",
    discovery: parseSeoDiscoverySettings(JSON.stringify({ sitemap: { products: false }, feeds: { title: "Feed" } })),
    returnPolicy: parseSeoReturnPolicySettings(JSON.stringify({
      enabled: true,
      category: "finite",
      returnWindowDays: 14,
      returnFees: "free",
      returnMethod: "by_mail",
      country: "BD",
    })),
  });
  const orderChannels = await getNotificationChannels(db);
  expect(orderChannels.order_created).toEqual(["email", "sms"]);
  expect(orderChannels.order_shipped).toEqual(["whatsapp"]);
  expect(orderChannels.order_delivered).toEqual(["email"]);
  expect((await getAdminNotificationChannels(db)).order_created).toEqual([]);
  expect((await getAdminNotificationChannels(db)).order_cancelled).toEqual(["push"]);
  expect(await getOrderWhatsAppTemplateSettings(db)).toEqual({ templateName: "order_update", languageCode: "bn" });
  expect(await getSmsSettings(db, KEY)).toMatchObject({
    activeProvider: "smsnetbd",
    activeProviderConfigured: true,
    smsnetbdApiKey: "•".repeat(12),
    smsnetbdSenderId: "SHOP",
  });
}

function expectOnlyDocumentRows(sqlite: DatabaseSync) {
  expect(sqlite.prepare(
    "SELECT category, key FROM settings WHERE key <> 'document' ORDER BY category",
  ).all()).toEqual([
    { category: "fraud-checker", key: "provider_1" },
    { category: "notification_provider_health", key: "sms:smsnetbd" },
  ]);
  expect(sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE name IN ('site_settings', 'meta_conversions_settings')",
  ).all()).toEqual([]);
}
