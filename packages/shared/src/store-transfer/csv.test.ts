import { describe, expect, it } from "vitest";
import { CsvParseError, createCsvParser, csvCell, parseCsv, readCsvBlob, spreadsheetSafeText, toCsv } from "./csv";
import { cleanImportCell, importNumberProblem, parseImportDecimal, parseImportInteger, splitImportList } from "./values";
import { ImportFileError, parseImportText, readImportFile } from "./detect";
import { readFixture } from "./fixtures/fixture";

const fixtures = new Map(await Promise.all(["shopify-products.csv", "malformed.csv"].map(async (name) => [name, await readFixture(name)] as const)));
const fixture = (name: string) => fixtures.get(name)!;

describe("RFC 4180 parser", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    const { records } = parseCsv('a,b,c\r\n"x, y","say ""hi""","line 1\r\nline 2"\r\nlast,,\r\n');
    expect(records.map((record) => record.fields)).toEqual([
      ["a", "b", "c"],
      ["x, y", "say \"hi\"", "line 1\r\nline 2"],
      ["last", "", ""],
    ]);
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
  });

  it("strips a BOM, accepts LF, lone CR and a file without a final newline", () => {
    const { records } = parseCsv("﻿name,qty\nmug,2\rplate,3");
    expect(records.map((record) => record.fields)).toEqual([["name", "qty"], ["mug", "2"], ["plate", "3"]]);
  });

  it("detects semicolon and tab separated files and Excel's sep= hint", () => {
    expect(parseCsv("Handle;Price\nmug;12,50\n").records[1]!.fields).toEqual(["mug", "12,50"]);
    expect(parseCsv("Handle\tPrice\nmug\t450\n").records[1]!.fields).toEqual(["mug", "450"]);
    const hinted = parseCsv("sep=;\nHandle;Price\nmug;450\n");
    expect(hinted.delimiter).toBe(";");
    expect(hinted.records.map((record) => record.fields)).toEqual([["Handle", "Price"], ["mug", "450"]]);
  });

  it("keeps UTF-8 Bangla text intact", () => {
    const { records } = parseCsv("নাম,দাম\n\"নকশী কাঁথা, লাল\",৩৫০০\n");
    expect(records[1]!.fields).toEqual(["নকশী কাঁথা, লাল", "৩৫০০"]);
  });

  it("parses the same records whatever the chunk boundaries", () => {
    const text = fixture("shopify-products.csv");
    const whole = parseCsv(text).records;
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const records: Array<{ fields: string[]; line: number }> = [];
      const parser = createCsvParser((record) => records.push(record));
      for (let index = 0; index < text.length; index += size) parser.push(text.slice(index, index + size));
      parser.end();
      expect(records).toEqual(whole);
    }
  });

  it("counts lines inside quoted CRLF values across chunk boundaries", () => {
    const records: Array<{ line: number }> = [];
    const parser = createCsvParser((record) => records.push(record));
    parser.push("a,b\r\n\"x\r");
    parser.push("\ny\",z\r\nnext,1\r\n");
    parser.end();
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
  });

  it("refuses a quote that never closes, naming its line", () => {
    expect(() => parseCsv(fixture("malformed.csv"))).toThrowError(CsvParseError);
    try {
      parseCsv(fixture("malformed.csv"));
    } catch (error) {
      expect((error as CsvParseError).line).toBe(2);
    }
  });

  it("keeps a stray quote in an unquoted field as text", () => {
    expect(parseCsv('a,b\n12" pipe,x\n').records[1]!.fields).toEqual(['12" pipe', "x"]);
  });

  it("writes cells that parse back to the same values", () => {
    const rows = [["Handle", "Body"], ["mug", "<p>\"Hot\", tea</p>\nnext"], ["  padded ", ""], ["নকশী", "-5"]];
    const text = toCsv(rows, { spreadsheetSafe: false });
    expect(text.startsWith("﻿")).toBe(true);
    expect(parseCsv(text).records.map((record) => record.fields)).toEqual(rows);
    expect(csvCell("a,b")).toBe("\"a,b\"");
  });

  it("spreadsheet-safe text round-trips through the import cell cleaner", () => {
    for (const value of ["=SUM(A1)", "+8801712345678", "@handle", "-12", "plain"]) {
      expect(cleanImportCell(spreadsheetSafeText(value))).toBe(value);
    }
    expect(spreadsheetSafeText("=SUM(A1)")).toBe("'=SUM(A1)");
  });

  it("reads a Blob as UTF-8 and falls back to Windows-1252 for Excel's legacy CSV", async () => {
    const utf8 = new Blob(["﻿name,price\nনকশী,350\n"]);
    const records: string[][] = [];
    const result = await readCsvBlob(utf8, (record) => records.push(record.fields));
    expect(result.encoding).toBe("utf-8");
    expect(records[1]).toEqual(["নকশী", "350"]);

    const latin = new Blob([new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a])]);
    const latinRecords: string[][] = [];
    const fallback = await readCsvBlob(latin, (record) => latinRecords.push(record.fields));
    expect(fallback.encoding).toBe("windows-1252");
    expect(latinRecords[1]).toEqual(["Café"]);
  });

  it("refuses empty files and files with no header", async () => {
    await expect(readImportFile(new Blob([]))).rejects.toBeInstanceOf(ImportFileError);
    expect(() => parseImportText(",,\n1,2,3\n")).toThrowError(ImportFileError);
  });
});

describe("import cell values", () => {
  it("reads spreadsheet numbers", () => {
    expect(parseImportDecimal("1,250.50")).toEqual({ ok: true, value: 1250.5 });
    expect(parseImportDecimal("৳ ১,২৫০")).toEqual({ ok: true, value: 1250 });
    expect(parseImportDecimal("1,25,000")).toEqual({ ok: true, value: 125000 });
    expect(parseImportDecimal("12,50")).toEqual({ ok: true, value: 12.5 });
    expect(parseImportDecimal("Tk 450")).toEqual({ ok: true, value: 450 });
    expect(parseImportDecimal("")).toEqual({ ok: true, value: null });
    expect(parseImportDecimal("call us")).toEqual({ ok: false });
    expect(parseImportInteger("3.5")).toEqual({ ok: false });
    expect(parseImportInteger("১২")).toEqual({ ok: true, value: 12 });
  });

  it("tells a number below 0 from text that is not a number", () => {
    expect(parseImportDecimal("-5")).toEqual({ ok: false, negative: true });
    expect(parseImportDecimal("−1,250.50")).toEqual({ ok: false, negative: true });
    expect(parseImportDecimal("-৳ 450")).toEqual({ ok: false, negative: true });
    expect(parseImportDecimal("-0")).toEqual({ ok: true, value: 0 });
    expect(parseImportDecimal("-call")).toEqual({ ok: false });
    expect(importNumberProblem("Price", "-5", { ok: false, negative: true })).toBe('Price "-5" must be 0 or more.');
    expect(importNumberProblem("Price", "call us", { ok: false })).toBe('Price "call us" is not a number.');
  });

  it("splits WooCommerce lists with escaped commas", () => {
    expect(splitImportList("Grocery > Tea\\, Coffee, Sale")).toEqual(["Grocery > Tea, Coffee", "Sale"]);
  });
});
