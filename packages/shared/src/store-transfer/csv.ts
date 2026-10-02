// CSV for store migration (RFC 4180, as real exporters write it).
//
// The parser is a push parser: feed it decoded text in chunks of any size
// (a file read through `TextDecoderStream`, or one string) and it emits one
// record per row, so a large export is never one giant string. It accepts
// what Shopify, WooCommerce and Excel produce: a UTF-8 byte order mark,
// quoted fields with doubled quotes and embedded line breaks, CRLF, LF or a
// lone CR between rows, Excel's `sep=;` first line, and semicolon or tab
// separated files from locales that write decimals with a comma. A quote
// inside an unquoted field is kept as text (Excel does the same). The only
// fatal error is a quoted field that never closes.
//
// The writer quotes exactly what needs quoting and always writes CRLF, so its
// output parses back to the same cells.

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvRecord {
  /** Cell text exactly as written (quotes removed, doubled quotes undone). */
  fields: string[];
  /** 1-based physical line on which the record starts. */
  line: number;
}

export class CsvParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "CsvParseError";
    this.line = line;
  }
}

export interface CsvParserOptions {
  /** Detected from the first row when omitted. */
  delimiter?: CsvDelimiter;
  /** A single cell longer than this (characters) is refused. Default 1,000,000. */
  maxFieldLength?: number;
  /** A row with more cells than this is refused. Default 1,024. */
  maxFields?: number;
}

export interface CsvParser {
  push(chunk: string): void;
  /** Flushes the last row; throws for a quote that never closed. */
  end(): void;
  /** The separator in use (known after the first row). */
  readonly delimiter: CsvDelimiter | null;
}

const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

/** The separator a header row most likely uses: the most frequent of , ; and tab outside quotes. */
export function detectCsvDelimiter(firstLine: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (const char of firstLine) {
    if (char === "\"") quoted = !quoted;
    else if (!quoted && counts.has(char as CsvDelimiter)) {
      counts.set(char as CsvDelimiter, counts.get(char as CsvDelimiter)! + 1);
    }
  }
  let best: CsvDelimiter = ",";
  for (const delimiter of DELIMITERS) {
    if (counts.get(delimiter)! > counts.get(best)!) best = delimiter;
  }
  return best;
}

const enum State {
  FieldStart,
  Unquoted,
  Quoted,
  QuoteInQuoted,
}

/**
 * A streaming RFC 4180 parser. Records with no content (blank lines) are
 * skipped; every other record is passed to `onRecord` in file order.
 */
export function createCsvParser(onRecord: (record: CsvRecord) => void, options: CsvParserOptions = {}): CsvParser {
  const maxFieldLength = options.maxFieldLength ?? 1_000_000;
  const maxFields = options.maxFields ?? 1_024;
  let delimiter: CsvDelimiter | null = options.delimiter ?? null;
  // Text held back until the first line is complete (to detect the separator).
  let head: string | null = delimiter ? null : "";
  let started = false;
  let state = State.FieldStart;
  let field = "";
  let fields: string[] = [];
  let line = 1;
  let recordLine = 1;
  let skipLineFeed = false;
  let firstRecord = true;
  // A CR inside a quoted value whose LF may arrive in the next chunk.
  let quotedCarriageReturn = false;

  const endField = () => {
    if (fields.length >= maxFields) {
      throw new CsvParseError(`A row has more than ${maxFields} columns.`, recordLine);
    }
    fields.push(field);
    field = "";
  };

  const endRecord = () => {
    endField();
    const record = fields;
    fields = [];
    const blank = record.length === 1 && record[0] === "";
    if (firstRecord && /^sep=.$/i.test(record.join(delimiter ?? ","))) {
      // Excel's separator hint; the separator was already taken from it.
      firstRecord = false;
      return;
    }
    if (!blank) {
      firstRecord = false;
      onRecord({ fields: record, line: recordLine });
    }
  };

  const growField = (text: string) => {
    if (field.length + text.length > maxFieldLength) {
      throw new CsvParseError(
        state === State.Quoted
          ? "A quoted value never closes. Check for a stray quote mark on this line."
          : `A value is longer than ${maxFieldLength} characters.`,
        recordLine,
      );
    }
    field += text;
  };

  const consume = (text: string) => {
    const sep = delimiter!;
    let index = 0;
    const length = text.length;
    while (index < length) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (text[index] === "\n") {
          index += 1;
          continue;
        }
      }
      if (state === State.FieldStart && fields.length === 0 && field === "") recordLine = line;
      const char = text[index]!;
      switch (state) {
        case State.FieldStart:
          if (char === "\"") {
            state = State.Quoted;
            index += 1;
          } else if (char === sep) {
            endField();
            index += 1;
          } else if (char === "\r" || char === "\n") {
            endRecord();
            line += 1;
            skipLineFeed = char === "\r";
            index += 1;
          } else {
            state = State.Unquoted;
          }
          break;
        case State.Unquoted: {
          let end = index;
          while (end < length) {
            const next = text[end]!;
            if (next === sep || next === "\r" || next === "\n") break;
            end += 1;
          }
          if (end > index) growField(text.slice(index, end));
          index = end;
          if (index < length) {
            const stop = text[index]!;
            if (stop === sep) {
              endField();
            } else {
              endRecord();
              line += 1;
              skipLineFeed = stop === "\r";
            }
            state = State.FieldStart;
            index += 1;
          }
          break;
        }
        case State.Quoted: {
          let end = index;
          while (end < length && text[end] !== "\"") {
            const next = text[end]!;
            if (next === "\r") line += 1;
            else if (next === "\n" && !quotedCarriageReturn) line += 1;
            quotedCarriageReturn = next === "\r";
            end += 1;
          }
          if (end > index) growField(text.slice(index, end));
          index = end;
          if (index < length) {
            quotedCarriageReturn = false;
            state = State.QuoteInQuoted;
            index += 1;
          }
          break;
        }
        case State.QuoteInQuoted:
          if (char === "\"") {
            growField("\"");
            state = State.Quoted;
            index += 1;
          } else if (char === sep) {
            endField();
            state = State.FieldStart;
            index += 1;
          } else if (char === "\r" || char === "\n") {
            endRecord();
            line += 1;
            skipLineFeed = char === "\r";
            state = State.FieldStart;
            index += 1;
          } else {
            // `"abc"def`: not RFC 4180, but keep the text rather than lose it.
            state = State.Unquoted;
          }
          break;
      }
    }
  };

  const takeHead = (final: boolean) => {
    if (head === null) return;
    // The first line ends at the first line break outside quotes.
    let quoted = false;
    let end = -1;
    for (let index = 0; index < head.length; index += 1) {
      const char = head[index]!;
      if (char === "\"") quoted = !quoted;
      else if (!quoted && (char === "\n" || char === "\r")) {
        end = index;
        break;
      }
    }
    if (end < 0 && !final) return;
    const firstLine = end < 0 ? head : head.slice(0, end);
    const hint = /^sep=(.)$/i.exec(firstLine.trim());
    delimiter = hint && DELIMITERS.includes(hint[1] as CsvDelimiter)
      ? hint[1] as CsvDelimiter
      : detectCsvDelimiter(firstLine);
    const text = head;
    head = null;
    consume(text);
  };

  return {
    get delimiter() {
      return delimiter;
    },
    push(chunk: string) {
      let text = chunk;
      if (!started) {
        if (text.length === 0) return;
        started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (head !== null) {
        head += text;
        takeHead(false);
        return;
      }
      consume(text);
    },
    end() {
      takeHead(true);
      if (state === State.Quoted) {
        throw new CsvParseError("A quoted value never closes. Check for a stray quote mark on this line.", recordLine);
      }
      if (state !== State.FieldStart || field !== "" || fields.length > 0) endRecord();
      state = State.FieldStart;
    },
  };
}

/** Every record of a CSV text (convenience for small inputs and tests). */
export function parseCsv(text: string, options: CsvParserOptions = {}): { records: CsvRecord[]; delimiter: CsvDelimiter } {
  const records: CsvRecord[] = [];
  const parser = createCsvParser((record) => records.push(record), options);
  parser.push(text);
  parser.end();
  return { records, delimiter: parser.delimiter ?? "," };
}

// ── Decoding ───────────────────────────────────────────────────────────────

export type CsvEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

/** The encoding a file's first bytes announce (UTF-16 needs its byte order mark). */
export function sniffCsvEncoding(firstBytes: Uint8Array): CsvEncoding {
  if (firstBytes[0] === 0xff && firstBytes[1] === 0xfe) return "utf-16le";
  if (firstBytes[0] === 0xfe && firstBytes[1] === 0xff) return "utf-16be";
  return "utf-8";
}

export interface CsvFileReadResult {
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  /** Bytes read (the whole file unless stopped). */
  bytes: number;
}

/**
 * Streams a file through the parser. UTF-8 is read strictly: a file saved by
 * Excel as "CSV (Comma delimited)" (Windows-1252) fails that check and is
 * read again as Windows-1252, which `encoding` reports (Bangla text cannot
 * survive that encoding, so the caller should warn).
 */
export async function readCsvBlob(
  blob: Blob,
  onRecord: (record: CsvRecord) => void,
  options: CsvParserOptions & { onProgress?: (bytesRead: number) => void; signal?: AbortSignal } = {},
): Promise<CsvFileReadResult> {
  const sniffed = sniffCsvEncoding(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
  const attempt = async (encoding: CsvEncoding, emit: (record: CsvRecord) => void) => {
    const parser = createCsvParser(emit, options);
    const decoder = new TextDecoder(encoding, { fatal: encoding === "utf-8" });
    const reader = blob.stream().getReader();
    let bytes = 0;
    try {
      for (;;) {
        if (options.signal?.aborted) throw new DOMException("The read was cancelled.", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        parser.push(decoder.decode(value, { stream: true }));
        options.onProgress?.(bytes);
      }
      parser.push(decoder.decode());
      parser.end();
    } finally {
      reader.releaseLock();
    }
    return { encoding, delimiter: parser.delimiter ?? ",", bytes } satisfies CsvFileReadResult;
  };
  if (sniffed !== "utf-8") return attempt(sniffed, onRecord);
  // Hold records back so a late invalid byte cannot leave half a file emitted twice.
  const buffered: CsvRecord[] = [];
  try {
    const result = await attempt("utf-8", (record) => buffered.push(record));
    for (const record of buffered) onRecord(record);
    return result;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return attempt("windows-1252", onRecord);
  }
}

// ── Writing ────────────────────────────────────────────────────────────────

/** One cell, quoted only when it has to be. */
export function csvCell(value: unknown, delimiter: CsvDelimiter = ","): string {
  const text = value == null ? "" : String(value);
  if (text === "") return "";
  const needsQuotes = text.includes(delimiter)
    || text.includes("\"")
    || text.includes("\n")
    || text.includes("\r")
    || text !== text.trim();
  return needsQuotes ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/**
 * A cell a spreadsheet will not run as a formula: text starting with = + - @
 * (or a tab/CR) gets a leading apostrophe, except an international phone
 * number. `cleanImportCell` undoes exactly this on the way back in.
 */
export function spreadsheetSafeText(value: unknown): string {
  const text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  return /^[\t\r=+\-@]/.test(text) && !/^\+\d{6,15}$/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)
    ? `'${text}`
    : text;
}

/** CSV text for rows (the first row is the header), with a BOM so Excel reads UTF-8 (Bangla) correctly. */
export function toCsv(rows: readonly (readonly unknown[])[], options: { bom?: boolean; spreadsheetSafe?: boolean } = {}): string {
  const safe = options.spreadsheetSafe ?? true;
  const body = rows
    .map((row) => row.map((cell) => csvCell(safe ? spreadsheetSafeText(cell) : cell)).join(","))
    .join("\r\n");
  return `${options.bom === false ? "" : "﻿"}${body}\r\n`;
}
