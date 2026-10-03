// Customers from Shopify, WooCommerce or our own customer export to import
// items, and the item schema the API validates again.
//
// Phone is the customer's identity in Bangladesh, so a row without a valid
// phone fails with a clear reason. Marketing consent is imported only when
// the file says yes for that channel; anything else (blank, no, unknown) is
// "not subscribed", never a fabricated consent.

import { z } from "zod";
import { validateAndFormatPhone } from "../customer-utils";
import { ADDRESS_FIELD_MAX_LENGTH } from "../address";
import { normalizeMarketCountry } from "../markets";
import { normalizeCustomerTags, CUSTOMER_TAGS_PER_CUSTOMER_MAX } from "../customer-marketing";
import type { ImportIssue, UnsupportedSummary } from "./issues";
import { UnsupportedCollector } from "./issues";
import { ColumnIndex, isScientificNotation, parseImportBoolean, splitImportList, truncateText, type CsvTable } from "./values";

export const CUSTOMER_IMPORT_MODES = ["create", "upsert"] as const;
export const CUSTOMER_IMPORT_BATCH_MAX = 100;
export const CUSTOMER_IMPORT_BATCH_DEFAULT = 50;
export const CUSTOMER_NAME_MAX = 100;
export const CUSTOMER_ADDRESS_MAX = 500;

export const customerImportItemSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  line: z.number().int().min(1).nullable().default(null),
  /** Shown name; the phone is used when the file has none. */
  name: z.string().trim().max(CUSTOMER_NAME_MAX).nullable(),
  /** E.164 (validated again by the server against the store's phone policy). */
  phone: z.string().trim().min(7).max(16).regex(/^\+\d{7,15}$/, "Use the international format (+8801XXXXXXXXX)."),
  email: z.email().max(254).nullable(),
  /**
   * The source's default address in canonical fields (MARKETS-DESIGN D7). It
   * becomes the customer's default address; one that breaks its country's
   * rules (a Bangladesh address has no City/Thana ids in a file) is kept,
   * marked validation_skipped.
   */
  address: z.object({
    countryCode: z.string().trim().length(2).nullable(),
    company: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH.company).nullable(),
    line1: z.string().trim().max(CUSTOMER_ADDRESS_MAX).nullable(),
    line2: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH.line2).nullable(),
    locality: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH.locality).nullable(),
    adminArea: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH.adminArea).nullable(),
    postalCode: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH.postalCode).nullable(),
  }).strict().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(CUSTOMER_TAGS_PER_CUSTOMER_MAX).default([]),
  marketing: z.object({
    email: z.boolean().default(false),
    sms: z.boolean().default(false),
    whatsapp: z.boolean().default(false),
  }).default({ email: false, sms: false, whatsapp: false }),
  /** How the file recorded the consent (kept on the consent record as its evidence). */
  consentEvidence: z.string().trim().max(300).nullable().default(null),
});
export type CustomerImportItem = z.infer<typeof customerImportItemSchema>;

export const customerImportBatchSchema = z.object({
  mode: z.enum(CUSTOMER_IMPORT_MODES),
  dryRun: z.boolean().default(false),
  items: z.array(customerImportItemSchema).min(1).max(CUSTOMER_IMPORT_BATCH_MAX),
});
export type CustomerImportBatch = z.infer<typeof customerImportBatchSchema>;

export type CustomerSourceFormat = "shopify_customers" | "woocommerce_customers" | "scalius_customers";

export interface CustomerMappingResult {
  items: CustomerImportItem[];
  issues: ImportIssue[];
  unsupported: UnsupportedSummary[];
  stats: { rows: number; customers: number; failed: number; duplicates: number; emailConsents: number; smsConsents: number };
}

export interface CustomerMappingOptions {
  /** The store's phone country policy (e.g. only BD). */
  allowedPhoneCountries?: readonly string[];
}

const FORMAT_LABEL: Record<CustomerSourceFormat, string> = {
  shopify_customers: "Shopify customer export",
  woocommerce_customers: "WooCommerce customer export",
  scalius_customers: "Scalius customer export",
};

/** Normalized phone, or the reason it can't be used. */
export function importPhone(raw: string, allowedCountries?: readonly string[]): { ok: true; phone: string } | { ok: false; message: string; code: string } {
  const value = raw.trim();
  if (!value) return { ok: false, code: "phone_missing", message: "A phone number is required for every customer." };
  if (isScientificNotation(value)) {
    return { ok: false, code: "phone_scientific", message: `Phone "${value}" was turned into scientific notation by a spreadsheet; format the column as text and export again.` };
  }
  try {
    return { ok: true, phone: validateAndFormatPhone(value, allowedCountries ? [...allowedCountries] : undefined) };
  } catch (error) {
    return { ok: false, code: "phone_invalid", message: `Phone "${value}": ${error instanceof Error ? error.message : "not a valid number"}.` };
  }
}

type ImportAddress = NonNullable<CustomerImportItem["address"]>;

/** A source address in canonical fields (truncated to their limits), or null when the row has none. */
function importAddress(parts: Record<keyof ImportAddress, string>): ImportAddress | null {
  const text = (value: string, max: number) => (value.trim() ? truncateText(value.trim(), max) : null);
  const address: ImportAddress = {
    countryCode: normalizeMarketCountry(parts.countryCode),
    company: text(parts.company, ADDRESS_FIELD_MAX_LENGTH.company),
    line1: text(parts.line1, CUSTOMER_ADDRESS_MAX),
    line2: text(parts.line2, ADDRESS_FIELD_MAX_LENGTH.line2),
    locality: text(parts.locality, ADDRESS_FIELD_MAX_LENGTH.locality),
    adminArea: text(parts.adminArea, ADDRESS_FIELD_MAX_LENGTH.adminArea),
    postalCode: text(parts.postalCode, ADDRESS_FIELD_MAX_LENGTH.postalCode),
  };
  return address.line1 || address.line2 || address.locality ? address : null;
}

/** "subscribed"/"yes"/TRUE is consent; everything else is not. */
function consented(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (text === "subscribed") return true;
  return parseImportBoolean(text) === true;
}

/** Maps a parsed customer CSV of the given format. */
export function mapCustomers(table: CsvTable, format: CustomerSourceFormat, options: CustomerMappingOptions = {}): CustomerMappingResult {
  const columns = new ColumnIndex(table.headers);
  const issues: ImportIssue[] = [];
  const unsupported = new UnsupportedCollector();
  const items: CustomerImportItem[] = [];
  const phones = new Map<string, number>();
  const emails = new Map<string, number>();
  let failed = 0;
  let duplicates = 0;
  const label = FORMAT_LABEL[format];

  for (const row of table.rows) {
    const get = (...names: string[]) => columns.get(row.cells, ...names);
    let first = "";
    let last = "";
    let name = "";
    let phoneRaw = "";
    let email = "";
    let address: CustomerImportItem["address"] = null;
    let tags: string[] = [];
    let note = "";
    const marketing = { email: false, sms: false, whatsapp: false };
    const evidence: string[] = [];

    if (format === "shopify_customers") {
      first = get("First Name");
      last = get("Last Name");
      phoneRaw = get("Phone") || get("Default Address Phone", "Address Phone");
      email = get("Email");
      address = importAddress({
        company: get("Default Address Company", "Company"),
        line1: get("Default Address Address1", "Address1"),
        line2: get("Default Address Address2", "Address2"),
        locality: get("Default Address City", "City"),
        adminArea: get("Default Address Province Code", "Province", "Province Code"),
        postalCode: get("Default Address Zip", "Zip"),
        countryCode: get("Default Address Country Code", "Country Code", "Country"),
      });
      tags = splitImportList(get("Tags"));
      note = get("Note");
      const emailColumn = columns.find("Accepts Email Marketing", "Accepts Marketing");
      if (emailColumn && consented(get(emailColumn))) {
        marketing.email = true;
        evidence.push(`${emailColumn} = ${get(emailColumn)}`);
      }
      if (columns.has("Accepts SMS Marketing") && consented(get("Accepts SMS Marketing"))) {
        marketing.sms = true;
        evidence.push(`Accepts SMS Marketing = ${get("Accepts SMS Marketing")}`);
      }
      if (get("Total Orders") && get("Total Orders") !== "0") {
        unsupported.add("order_history", "Order counts and amounts spent (orders are not imported with customers).", get("Total Orders"));
      }
      if (parseImportBoolean(get("Tax Exempt")) === true) unsupported.add("tax_exempt", "Tax-exempt customers.", get("Email") || null);
    } else if (format === "woocommerce_customers") {
      first = get("billing_first_name", "Billing First Name", "first_name", "First Name");
      last = get("billing_last_name", "Billing Last Name", "last_name", "Last Name");
      name = get("Name", "display_name", "Display Name");
      phoneRaw = get("billing_phone", "Billing Phone", "Phone", "shipping_phone", "Shipping Phone");
      email = get("billing_email", "Billing Email", "user_email", "Email");
      address = importAddress({
        company: get("billing_company", "Billing Company"),
        line1: get("billing_address_1", "Billing Address 1", "Address 1"),
        line2: get("billing_address_2", "Billing Address 2", "Address 2"),
        locality: get("billing_city", "Billing City", "City"),
        adminArea: get("billing_state", "Billing State", "Region"),
        postalCode: get("billing_postcode", "Billing Postcode", "Postal Code"),
        countryCode: get("billing_country", "Billing Country", "Country / Region"),
      });
      const consentColumn = columns.find("Accepts Marketing", "accepts_marketing", "Newsletter", "newsletter_subscribed");
      if (consentColumn && consented(get(consentColumn))) {
        marketing.email = true;
        evidence.push(`${consentColumn} = ${get(consentColumn)}`);
      }
      if (get("Orders", "orders_count") && get("Orders", "orders_count") !== "0") {
        unsupported.add("order_history", "Order counts and amounts spent (orders are not imported with customers).", get("Orders", "orders_count"));
      }
      if (get("Username", "user_login")) unsupported.add("wordpress_logins", "WordPress usernames and passwords (customers sign in with a code instead).", null);
    } else {
      name = get("Name");
      phoneRaw = get("Phone");
      email = get("Email");
      // Our own export: City and Zone (Bangladesh: city and thana; elsewhere: locality and region) and Country.
      const country = normalizeMarketCountry(get("Country"));
      address = importAddress({
        company: "",
        line1: get("Address"),
        line2: "",
        locality: get("City"),
        adminArea: country && country !== "BD" ? get("Zone") : "",
        postalCode: "",
        countryCode: get("Country"),
      });
      tags = splitImportList(get("Tags"));
      for (const [channel, column] of [["email", "Email marketing"], ["sms", "SMS marketing"], ["whatsapp", "WhatsApp marketing"]] as const) {
        if (get(column).toLowerCase() === "subscribed") {
          marketing[channel] = true;
          evidence.push(`${column} = subscribed`);
        }
      }
    }

    if (note) unsupported.add("customer_notes", "Customer notes.", null);
    const fullName = (name || `${first} ${last}`).replace(/\s+/g, " ").trim();
    const ref = email || phoneRaw || fullName || `line ${row.line}`;
    const phone = importPhone(phoneRaw, options.allowedPhoneCountries);
    if (!phone.ok) {
      issues.push({ severity: "error", code: phone.code, message: phone.message, line: row.line, subject: ref, column: "Phone" });
      failed += 1;
      continue;
    }
    const normalizedEmail = email.trim().toLowerCase();
    let emailValue: string | null = normalizedEmail || null;
    if (emailValue && !z.email().safeParse(emailValue).success) {
      issues.push({ severity: "warning", code: "email_invalid", message: `Email "${email}" is not valid and was left out.`, line: row.line, subject: phone.phone, column: "Email" });
      emailValue = null;
      marketing.email = false;
    }
    const phoneSeen = phones.get(phone.phone);
    if (phoneSeen !== undefined) {
      issues.push({ severity: "warning", code: "duplicate_phone", message: `Same phone as line ${phoneSeen}; this row was skipped.`, line: row.line, subject: phone.phone, params: { line: phoneSeen } });
      duplicates += 1;
      continue;
    }
    const emailSeen = emailValue ? emails.get(emailValue) : undefined;
    if (emailSeen !== undefined) {
      issues.push({ severity: "warning", code: "duplicate_email", message: `Same email as line ${emailSeen} with a different phone; this row was skipped.`, line: row.line, subject: phone.phone, params: { line: emailSeen } });
      duplicates += 1;
      continue;
    }
    phones.set(phone.phone, row.line);
    if (emailValue) emails.set(emailValue, row.line);
    if (marketing.email && !emailValue) marketing.email = false;
    const tagResult = normalizeCustomerTags(tags);
    if (tagResult.invalid.length > 0) {
      issues.push({ severity: "warning", code: "tag_invalid", message: `Tags longer than 40 characters were left out: ${tagResult.invalid.slice(0, 3).join(", ")}.`, line: row.line, subject: phone.phone, column: "Tags" });
    }
    if (tagResult.tags.length > CUSTOMER_TAGS_PER_CUSTOMER_MAX) {
      issues.push({ severity: "warning", code: "tags_too_many", message: `Only the first ${CUSTOMER_TAGS_PER_CUSTOMER_MAX} tags were kept.`, line: row.line, subject: phone.phone, column: "Tags" });
    }
    items.push({
      ref,
      line: row.line,
      name: fullName ? truncateText(fullName, CUSTOMER_NAME_MAX) : null,
      phone: phone.phone,
      email: emailValue,
      address,
      tags: tagResult.tags.slice(0, CUSTOMER_TAGS_PER_CUSTOMER_MAX),
      marketing,
      consentEvidence: evidence.length > 0 ? truncateText(`${label}: ${evidence.join("; ")}`, 300) : null,
    });
  }
  return {
    items,
    issues,
    unsupported: unsupported.list(),
    stats: {
      rows: table.rows.length,
      customers: items.length,
      failed,
      duplicates,
      emailConsents: items.filter((item) => item.marketing.email).length,
      smsConsents: items.filter((item) => item.marketing.sms).length,
    },
  };
}
