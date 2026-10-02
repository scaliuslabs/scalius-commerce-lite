// Small sample files in the formats the import reads, so a merchant coming
// from a spreadsheet has a template.
import { toCsv } from "@scalius/shared/store-transfer/csv";
import { SHOPIFY_PRODUCT_COLUMNS } from "@scalius/shared/store-transfer/shopify-products";
import { SCALIUS_INVENTORY_COLUMNS } from "@scalius/shared/store-transfer/inventory";
import type { ImportKind } from "./import-plan";

function rows(columns: readonly string[], values: ReadonlyArray<Record<string, string>>): string[][] {
  return [[...columns], ...values.map((row) => columns.map((column) => row[column] ?? ""))];
}

const PRODUCT_ROWS: Array<Record<string, string>> = [
  {
    Handle: "cotton-panjabi", Title: "Cotton Panjabi", "Body (HTML)": "<p>Soft cotton panjabi for everyday wear.</p>", Vendor: "My Brand",
    Type: "Men > Panjabi", Published: "TRUE", "Option1 Name": "Size", "Option1 Value": "M", "Option2 Name": "Color", "Option2 Value": "White",
    "Variant SKU": "PJ-M-WHITE", "Variant Grams": "350", "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "10",
    "Variant Price": "1450", "Variant Compare At Price": "1650", "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE",
    "Image Src": "https://example.com/images/panjabi-white.jpg", "Image Position": "1", "Gift Card": "FALSE", Status: "active",
  },
  {
    Handle: "cotton-panjabi", "Option1 Value": "L", "Option2 Value": "White", "Variant SKU": "PJ-L-WHITE", "Variant Grams": "380",
    "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "6", "Variant Price": "1450", "Variant Compare At Price": "1650",
    "Variant Requires Shipping": "TRUE", "Variant Taxable": "TRUE",
  },
  {
    Handle: "clay-mug", Title: "মাটির মগ", "Body (HTML)": "<p>হাতে তৈরি মাটির মগ, ৩৫০ মিলি।</p>", Vendor: "My Brand", Type: "Home > Kitchen",
    Published: "TRUE", "Option1 Name": "Title", "Option1 Value": "Default Title", "Variant SKU": "MUG-350", "Variant Grams": "420",
    "Variant Inventory Tracker": "shopify", "Variant Inventory Qty": "25", "Variant Price": "450", "Variant Requires Shipping": "TRUE",
    "Variant Taxable": "TRUE", "Gift Card": "FALSE", Status: "active",
  },
];

const CUSTOMER_COLUMNS = ["First Name", "Last Name", "Email", "Accepts Email Marketing", "Default Address Address1", "Default Address City", "Default Address Country Code", "Phone", "Accepts SMS Marketing", "Tags", "Note"];
const CUSTOMER_ROWS: Array<Record<string, string>> = [
  { "First Name": "রহিম", "Last Name": "উদ্দিন", Email: "rahim@example.com", "Accepts Email Marketing": "yes", "Default Address Address1": "House 12, Road 5", "Default Address City": "Dhaka", "Default Address Country Code": "BD", Phone: "+8801712345678", "Accepts SMS Marketing": "yes", Tags: "vip" },
  { "First Name": "Karim", "Last Name": "Ahmed", Email: "", "Accepts Email Marketing": "no", "Default Address City": "Chattogram", "Default Address Country Code": "BD", Phone: "01812345678", "Accepts SMS Marketing": "no", Tags: "" },
];

const INVENTORY_ROWS: Array<Record<string, string>> = [
  { Handle: "cotton-panjabi", Title: "Cotton Panjabi", Variant: "M / White", SKU: "PJ-M-WHITE", Location: "Main location", "Location code": "MAIN", "On hand": "10" },
  { Handle: "clay-mug", Title: "মাটির মগ", Variant: "", SKU: "MUG-350", Location: "Main location", "Location code": "MAIN", "On hand": "25" },
];

/** The sample CSV for an import kind. */
export function sampleCsv(kind: ImportKind): { filename: string; csv: string } {
  if (kind === "customers") return { filename: "customers-sample.csv", csv: toCsv(rows(CUSTOMER_COLUMNS, CUSTOMER_ROWS)) };
  if (kind === "inventory") return { filename: "inventory-sample.csv", csv: toCsv(rows(SCALIUS_INVENTORY_COLUMNS, INVENTORY_ROWS)) };
  return { filename: "products-sample.csv", csv: toCsv(rows(SHOPIFY_PRODUCT_COLUMNS, PRODUCT_ROWS)) };
}
