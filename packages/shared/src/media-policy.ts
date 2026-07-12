const MIB = 1024 * 1024;

export const MEDIA_KINDS = ["image", "video"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_MAX_FILES_PER_UPLOAD = 50;
export const MEDIA_MAX_FILENAME_LENGTH = 255;
export const MEDIA_SIGNATURE_READ_BYTES = 4 * 1024;
export const MEDIA_MULTIPART_PART_SIZE_BYTES = 5 * MIB;
export const MEDIA_MULTIPART_MAX_PARTS = 20;

export const MEDIA_POLICY = {
  "image/jpeg": {
    kind: "image",
    extensions: ["jpg", "jpeg"],
    preferredExtension: "jpg",
    maxBytes: 20 * MIB,
    label: "JPEG",
  },
  "image/png": {
    kind: "image",
    extensions: ["png"],
    preferredExtension: "png",
    maxBytes: 20 * MIB,
    label: "PNG",
  },
  "image/gif": {
    kind: "image",
    extensions: ["gif"],
    preferredExtension: "gif",
    maxBytes: 20 * MIB,
    label: "GIF",
  },
  "image/webp": {
    kind: "image",
    extensions: ["webp"],
    preferredExtension: "webp",
    maxBytes: 20 * MIB,
    label: "WebP",
  },
  "image/avif": {
    kind: "image",
    extensions: ["avif"],
    preferredExtension: "avif",
    maxBytes: 20 * MIB,
    label: "AVIF",
  },
  "video/mp4": {
    kind: "video",
    extensions: ["mp4"],
    preferredExtension: "mp4",
    maxBytes: 100 * MIB,
    label: "MP4",
  },
  "video/webm": {
    kind: "video",
    extensions: ["webm"],
    preferredExtension: "webm",
    maxBytes: 100 * MIB,
    label: "WebM",
  },
} as const satisfies Record<
  string,
  {
    kind: MediaKind;
    extensions: readonly string[];
    preferredExtension: string;
    maxBytes: number;
    label: string;
  }
>;

export type SupportedMediaMimeType = keyof typeof MEDIA_POLICY;

export interface ValidatedMediaMetadata {
  filename: string;
  extension: string;
  mimeType: SupportedMediaMimeType;
  kind: MediaKind;
  size: number;
  maxBytes: number;
}

export type MediaValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const WEBM_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3] as const;
const MP4_BRANDS = new Set([
  "3gp4",
  "3gp5",
  "3gp6",
  "avc1",
  "dash",
  "iso2",
  "iso5",
  "iso6",
  "isom",
  "m4v ",
  "mp41",
  "mp42",
  "msnv",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function hasPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return (
    bytes.byteLength >= expected.length &&
    expected.every((byte, index) => bytes[index] === byte)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let output = "";
  const end = Math.min(bytes.byteLength, offset + length);
  for (let index = offset; index < end; index += 1) {
    output += String.fromCharCode(bytes[index] ?? 0);
  }
  return output;
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  if (bytes.byteLength < offset + 4) return null;
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function isoBaseMediaBrands(bytes: Uint8Array): string[] | null {
  if (bytes.byteLength < 16 || ascii(bytes, 4, 4) !== "ftyp") return null;
  const boxSize = readUint32(bytes, 0);
  if (boxSize === null || boxSize < 16) return null;

  const availableBoxSize = Math.min(boxSize, bytes.byteLength);
  const brands = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= availableBoxSize; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  return brands;
}

function includesAscii(bytes: Uint8Array, expected: string): boolean {
  if (bytes.byteLength < expected.length) return false;
  for (let start = 0; start <= bytes.byteLength - expected.length; start += 1) {
    let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      if (bytes[start + index] !== expected.charCodeAt(index)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeMediaMimeType(
  value: string | null | undefined,
): SupportedMediaMimeType | null {
  const normalized = value?.trim().toLowerCase();
  const canonical = normalized === "image/jpg" ? "image/jpeg" : normalized;
  return canonical && canonical in MEDIA_POLICY
    ? (canonical as SupportedMediaMimeType)
    : null;
}

export function getMediaPolicy(mimeType: SupportedMediaMimeType) {
  return MEDIA_POLICY[mimeType];
}

export function validateMediaFileMetadata(input: {
  filename: string;
  mimeType: string;
  size: number;
  expectedKind?: MediaKind;
}): MediaValidationResult<ValidatedMediaMetadata> {
  const filename = input.filename.trim();
  if (!filename) return { ok: false, error: "Invalid file name" };
  if (
    filename.length > MEDIA_MAX_FILENAME_LENGTH ||
    hasUnsafeFilenameCharacter(filename)
  ) {
    return { ok: false, error: "File name is invalid or too long" };
  }

  const mimeType = normalizeMediaMimeType(input.mimeType);
  if (!mimeType) {
    return {
      ok: false,
      error:
        "Unsupported file type. Allowed: JPEG, PNG, GIF, WebP, AVIF, MP4, WebM",
    };
  }

  const policy = MEDIA_POLICY[mimeType];
  if (input.expectedKind && policy.kind !== input.expectedKind) {
    return {
      ok: false,
      error: `Expected a ${input.expectedKind} file, received ${policy.kind}`,
    };
  }

  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    return { ok: false, error: "File is empty or has an invalid size" };
  }
  if (input.size > policy.maxBytes) {
    const sizeMb = (input.size / MIB).toFixed(2);
    const limitMb = policy.maxBytes / MIB;
    return {
      ok: false,
      error: `File size (${sizeMb} MB) exceeds the ${limitMb} MB ${policy.kind} limit`,
    };
  }

  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!policy.extensions.some((value) => value === extension)) {
    return {
      ok: false,
      error: `${policy.label} files must use ${policy.extensions
        .map((value) => `.${value}`)
        .join(" or ")}`,
    };
  }

  return {
    ok: true,
    value: {
      filename,
      extension,
      mimeType,
      kind: policy.kind,
      size: input.size,
      maxBytes: policy.maxBytes,
    },
  };
}

export function detectMediaMimeType(
  source: Uint8Array | ArrayBuffer,
): SupportedMediaMimeType | null {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (hasPrefix(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (hasPrefix(bytes, PNG_SIGNATURE)) return "image/png";

  const gifHeader = ascii(bytes, 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (
    hasPrefix(bytes, WEBM_SIGNATURE) &&
    includesAscii(bytes.subarray(4), "webm")
  ) {
    return "video/webm";
  }

  const brands = isoBaseMediaBrands(bytes);
  if (brands?.some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
  if (brands?.some((brand) => MP4_BRANDS.has(brand.toLowerCase()))) {
    return "video/mp4";
  }
  return null;
}

export function validateMediaSignature(
  source: Uint8Array | ArrayBuffer,
  declaredMimeType: string,
): MediaValidationResult<SupportedMediaMimeType> {
  const declared = normalizeMediaMimeType(declaredMimeType);
  if (!declared) {
    return { ok: false, error: "The declared media type is not supported" };
  }

  const detected = detectMediaMimeType(source);
  if (!detected) {
    return { ok: false, error: "The file signature is not a supported media type" };
  }
  if (detected !== declared) {
    return {
      ok: false,
      error: `File content is ${detected}, not the declared ${declared}`,
    };
  }
  return { ok: true, value: detected };
}
