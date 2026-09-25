import { describe, expect, it } from "vitest";

import {
  contentDispositionAttachment,
  DIGITAL_DOWNLOAD_TICKET_PURPOSE,
  DIGITAL_MAX_FILE_BYTES,
  DIGITAL_MAX_UPLOAD_PARTS,
  DIGITAL_UPLOAD_PART_BYTES,
  digitalObjectKey,
  digitalUploadPartCount,
  DOWNLOAD_FILENAME_MAX_LENGTH,
  isDigitalAccessDays,
  isDigitalDownloadLimit,
  LICENCE_KEY_CIPHER_PURPOSE,
  LICENCE_KEY_HASH_PURPOSE,
  LICENCE_KEY_IMPORT_MAX_KEYS,
  licenceKeyLast4,
  maskLicenceKey,
  normalizeLicenceKeyImport,
  sanitizeDownloadFilename,
} from "./digital";

const char = (code: number) => String.fromCharCode(code);

describe("digital limits", () => {
  it("bounds downloads and access", () => {
    expect([null, 1, 5, 100].every(isDigitalDownloadLimit)).toBe(true);
    expect([0, 101, 2.5, undefined, "5"].some(isDigitalDownloadLimit)).toBe(false);
    expect([null, 1, 3_650].every(isDigitalAccessDays)).toBe(true);
    expect([0, 3_651].some(isDigitalAccessDays)).toBe(false);
  });

  it("fixes the upload geometry at 50 MiB parts, 40 parts", () => {
    expect(DIGITAL_UPLOAD_PART_BYTES).toBe(52_428_800);
    expect(DIGITAL_MAX_FILE_BYTES).toBe(2_097_152_000);
    expect(DIGITAL_MAX_UPLOAD_PARTS).toBe(40);
    expect(digitalUploadPartCount(1)).toBe(1);
    expect(digitalUploadPartCount(DIGITAL_UPLOAD_PART_BYTES)).toBe(1);
    expect(digitalUploadPartCount(DIGITAL_UPLOAD_PART_BYTES + 1)).toBe(2);
    expect(digitalUploadPartCount(DIGITAL_MAX_FILE_BYTES)).toBe(40);
    expect(digitalUploadPartCount(DIGITAL_MAX_FILE_BYTES + 1)).toBeNull();
    expect(digitalUploadPartCount(0)).toBeNull();
  });

  it("keeps objects under the private prefix with opaque ids", () => {
    expect(digitalObjectKey("dga_01ABC", "dgu_02XYZ")).toBe("private/digital/dga_01ABC/dgu_02XYZ");
    expect(() => digitalObjectKey("../x", "dgu_1")).toThrow();
    expect(() => digitalObjectKey("dga_1", "a/b")).toThrow();
  });

  it("names the key-derivation purposes", () => {
    expect(DIGITAL_DOWNLOAD_TICKET_PURPOSE).toBe("digital-download-ticket");
    expect(LICENCE_KEY_HASH_PURPOSE).toBe("digital-licence-key-hash-v1");
    expect(LICENCE_KEY_CIPHER_PURPOSE).toBe("digital-licence-key-v1");
  });
});

describe("sanitizeDownloadFilename", () => {
  it("keeps ordinary names", () => {
    expect(sanitizeDownloadFilename("Design Kit v2.zip")).toBe("Design Kit v2.zip");
    expect(sanitizeDownloadFilename("বই.pdf")).toBe("বই.pdf");
  });

  it("drops paths, controls, reserved and disguising characters", () => {
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("C:\\Users\\x\\report.pdf")).toBe("report.pdf");
    expect(sanitizeDownloadFilename(`a${char(0)}b${char(0x1b)}c${char(0x85)}.txt`)).toBe("abc.txt");
    expect(sanitizeDownloadFilename('what<>:"|?*.pdf')).toBe("what.pdf");
    expect(sanitizeDownloadFilename(`photo${char(0x202e)}gnp.exe`)).toBe("photognp.exe");
    expect(sanitizeDownloadFilename(`x${char(0x200b)}y${char(0xfeff)}.pdf`)).toBe("xy.pdf");
    expect(sanitizeDownloadFilename(`bad${char(0xd800)}.pdf`)).toBe("bad.pdf");
    expect(sanitizeDownloadFilename("line\nbreak\t name.txt")).toBe("linebreak name.txt");
  });

  it("keeps Bangla joiners", () => {
    const name = `র${char(0x200d)}্যাব.pdf`;
    expect(sanitizeDownloadFilename(name)).toBe(name);
  });

  it("trims dots and spaces and falls back to download", () => {
    // A name that is only an extension keeps it behind the fallback stem.
    expect(sanitizeDownloadFilename("  ..hidden  ")).toBe("download.hidden");
    expect(sanitizeDownloadFilename(" . notes . txt ")).toBe("notes . txt");
    expect(sanitizeDownloadFilename(".pdf")).toBe("download.pdf");
    expect(sanitizeDownloadFilename("name. .zip")).toBe("name.zip");
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename(null)).toBe("download");
    expect(sanitizeDownloadFilename("///")).toBe("download");
    expect(sanitizeDownloadFilename("...")).toBe("download");
  });

  it("shortens the stem and keeps the extension", () => {
    const long = sanitizeDownloadFilename(`${"a".repeat(400)}.epub`);
    expect(Array.from(long)).toHaveLength(DOWNLOAD_FILENAME_MAX_LENGTH);
    expect(long.endsWith("a.epub")).toBe(true);
    const bangla = sanitizeDownloadFilename(`${"ক".repeat(400)}.pdf`);
    expect(Array.from(bangla)).toHaveLength(DOWNLOAD_FILENAME_MAX_LENGTH);
  });
});

describe("contentDispositionAttachment", () => {
  it("is always an attachment with an ASCII fallback and the exact UTF-8 name", () => {
    expect(contentDispositionAttachment("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDispositionAttachment("বই (১).pdf")).toBe(
      `attachment; filename="__ (_).pdf"; filename*=UTF-8''%E0%A6%AC%E0%A6%87%20%28%E0%A7%A7%29.pdf`,
    );
    expect(contentDispositionAttachment("it's 100%*!.zip")).toBe(
      `attachment; filename="it's 100_!.zip"; filename*=UTF-8''it%27s%20100%25%21.zip`,
    );
  });

  it("never lets a name break out of the header", () => {
    const header = contentDispositionAttachment(`a"; filename=evil.html\r\nX-Evil: 1`);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith("attachment; filename=\"")).toBe(true);
    expect(header.match(/"/g)).toHaveLength(2);
  });
});

describe("normalizeLicenceKeyImport", () => {
  it("reads one key per line, trims, skips blanks and dedupes keeping the first", () => {
    expect(normalizeLicenceKeyImport("  AAAA-1111 \r\n\r\nBBBB-2222\nAAAA-1111\naaaa-1111\n")).toEqual({
      keys: ["AAAA-1111", "BBBB-2222", "aaaa-1111"],
      rejects: [{ line: 4, reason: "duplicate" }],
      exceedsLimit: false,
    });
  });

  it("takes the first CSV column, quoted or not", () => {
    const csv = [`KEY-1,assigned later,note`, `"KEY,2","x"`, `"KEY ""3"""`, `  KEY-4  ,`].join("\n");
    expect(normalizeLicenceKeyImport(csv).keys).toEqual(["KEY-1", "KEY,2", 'KEY "3"', "KEY-4"]);
  });

  it("rejects over-long keys and control characters by line, never echoing the key", () => {
    const result = normalizeLicenceKeyImport(["ok-1", "x".repeat(201), `bad${char(7)}key`, "y".repeat(200)].join("\n"));
    expect(result.keys).toEqual(["ok-1", "y".repeat(200)]);
    expect(result.rejects).toEqual([{ line: 2, reason: "too_long" }, { line: 3, reason: "invalid_characters" }]);
    expect(JSON.stringify(result.rejects)).not.toContain("bad");
  });

  it("flags more than 500 keys instead of silently importing a prefix", () => {
    const text = Array.from({ length: LICENCE_KEY_IMPORT_MAX_KEYS + 3 }, (_, index) => `KEY-${index}`).join("\n");
    const result = normalizeLicenceKeyImport(text);
    expect(result.keys).toHaveLength(LICENCE_KEY_IMPORT_MAX_KEYS);
    expect(result.exceedsLimit).toBe(true);
    const exact = Array.from({ length: LICENCE_KEY_IMPORT_MAX_KEYS }, (_, index) => `KEY-${index}`).join("\n");
    expect(normalizeLicenceKeyImport(exact).exceedsLimit).toBe(false);
  });
});

describe("licence key masking", () => {
  it("shows at most the last four characters and never more than half the key", () => {
    expect(licenceKeyLast4("ABCD-EFGH-IJKL")).toBe("IJKL");
    expect(licenceKeyLast4("ABCDEF")).toBe("DEF");
    expect(licenceKeyLast4("AB")).toBe("B");
    expect(licenceKeyLast4("A")).toBe("");
    expect(maskLicenceKey("ABCD-EFGH-IJKL")).toBe("•••• IJKL");
    expect(maskLicenceKey("IJKL")).toBe("•••• IJKL");
    expect(maskLicenceKey("")).toBe("••••");
  });
});
