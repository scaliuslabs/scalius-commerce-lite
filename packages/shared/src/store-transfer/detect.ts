// Which store exported a CSV, from its header row alone.

import { readCsvBlob, parseCsv, type CsvDelimiter, type CsvEncoding, type CsvRecord } from "./csv";
import { ColumnIndex, type CsvTable } from "./values";

export const IMPORT_FORMATS = [
  "shopify_products",
  "woocommerce_products",
  "shopify_customers",
  "woocommerce_customers",
  "scalius_customers",
  "scalius_inventory",
  "shopify_inventory",
] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** What each format holds. */
export const IMPORT_FORMAT_KIND: Record<ImportFormat, "products" | "customers" | "inventory"> = {
  shopify_products: "products",
  woocommerce_products: "products",
  shopify_customers: "customers",
  woocommerce_customers: "customers",
  scalius_customers: "customers",
  scalius_inventory: "inventory",
  shopify_inventory: "inventory",
};

export interface FormatDetection {
  format: ImportFormat | null;
  /** Required columns of the closest format that the file lacks. */
  missing: string[];
}

const SIGNATURES: ReadonlyArray<{ format: ImportFormat; all: string[]; any?: string[] }> = [
  // Inventory files share Handle/Title with product files, so they are checked first.
  { format: "scalius_inventory", all: ["SKU", "Location code", "On hand"] },
  { format: "shopify_inventory", all: ["Handle", "SKU", "Location"], any: ["On hand", "On hand (new)", "Available", "Available (not editable)"] },
  // Our own product export uses Shopify's columns, so it is detected as Shopify.
  { format: "shopify_products", all: ["Handle", "Title"], any: ["Variant Price", "Variant SKU", "Option1 Name", "Body (HTML)"] },
  { format: "woocommerce_products", all: ["Type", "Name"], any: ["Regular price", "Parent", "Attribute 1 name", "In stock?"] },
  { format: "scalius_customers", all: ["Customer ID", "Name", "Phone"], any: ["SMS marketing", "WhatsApp marketing", "Customer since"] },
  { format: "shopify_customers", all: ["First Name", "Last Name", "Email"], any: ["Accepts Email Marketing", "Accepts Marketing", "Default Address Phone", "Phone", "Total Spent"] },
  { format: "woocommerce_customers", all: [], any: ["billing_phone", "Billing Phone", "billing_first_name", "Billing First Name", "Username"] },
];

export function detectImportFormat(headers: readonly string[]): FormatDetection {
  const columns = new ColumnIndex(headers);
  let closest: { format: ImportFormat; missing: string[] } | null = null;
  for (const signature of SIGNATURES) {
    const missing = signature.all.filter((name) => !columns.has(name));
    const anyMatched = !signature.any || signature.any.some((name) => columns.has(name));
    if (missing.length === 0 && anyMatched) return { format: signature.format, missing: [] };
    if (signature.all.length > 0 && missing.length < signature.all.length && (!closest || missing.length < closest.missing.length)) {
      closest = { format: signature.format, missing: anyMatched ? missing : [...missing, signature.any![0]!] };
    }
  }
  return { format: null, missing: closest?.missing ?? [] };
}

export interface ImportFile {
  table: CsvTable;
  detection: FormatDetection;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  bytes: number;
}

/** Most rows one import reads (a 20,000-product catalogue with variants fits). */
export const IMPORT_MAX_ROWS = 100_000;
/** Largest file the dashboard reads. */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export class ImportFileError extends Error {
  constructor(readonly code: "empty" | "too_large" | "too_many_rows" | "no_header", message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

function tableFrom(records: CsvRecord[]): CsvTable {
  const [header, ...rest] = records;
  if (!header) throw new ImportFileError("empty", "The file is empty.");
  const headers = header.fields.map((field) => field.trim());
  if (headers.every((field) => !field)) throw new ImportFileError("no_header", "The first row must name the columns.");
  return {
    headers,
    rows: rest.map((record) => ({ line: record.line, cells: record.fields })),
  };
}

/** Reads, decodes and parses an uploaded file, and detects its format. */
export async function readImportFile(
  blob: Blob,
  options: { onProgress?: (bytes: number) => void; signal?: AbortSignal } = {},
): Promise<ImportFile> {
  if (blob.size === 0) throw new ImportFileError("empty", "The file is empty.");
  if (blob.size > IMPORT_MAX_BYTES) throw new ImportFileError("too_large", "The file is larger than 50 MB. Split it into smaller files.");
  const records: CsvRecord[] = [];
  const read = await readCsvBlob(blob, (record) => {
    if (records.length > IMPORT_MAX_ROWS) throw new ImportFileError("too_many_rows", `The file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files.`);
    records.push(record);
  }, options);
  const table = tableFrom(records);
  return { table, detection: detectImportFormat(table.headers), encoding: read.encoding, delimiter: read.delimiter, bytes: read.bytes };
}

/** The same for CSV text already in memory (agents, tests). */
export function parseImportText(text: string): Omit<ImportFile, "encoding" | "bytes"> {
  const { records, delimiter } = parseCsv(text);
  const table = tableFrom(records);
  return { table, detection: detectImportFormat(table.headers), delimiter };
}
