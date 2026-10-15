// Order-preserving tuple encoding for plugin storage indexes.
//
// Each component is tagged (null < false < true < number < string) and
// self-delimiting: numbers are 8 bytes of IEEE 754 with the sign handled so
// byte order equals numeric order, strings are UTF-8 with 0x00 escaped as
// 0x00 0xFF and terminated by 0x00 0x01. The tuple is stored as lowercase hex,
// so comparisons, prefix ranges and ORDER BY agree byte-for-byte on D1,
// TursoDB and PostgreSQL whatever the column collation: every character is one
// of [0-9a-f], which sort identically in all of them.

import { ObjectError } from "./errors";

export type IndexScalar = string | number | boolean | null;

/** Longest UTF-8 string one indexed field may hold. */
export const OBJECT_INDEX_STRING_MAX_BYTES = 256;
/** Longest encoded tuple (bytes; the hex column is twice this). */
export const OBJECT_INDEX_TUPLE_MAX_BYTES = 1024;

const TAG_NULL = 0x01;
const TAG_FALSE = 0x02;
const TAG_TRUE = 0x03;
const TAG_NUMBER = 0x04;
const TAG_STRING = 0x05;

const encoder = new TextEncoder();

function pushNumber(value: number, out: number[]): void {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Object.is(value, -0) ? 0 : value);
  const bytes = new Uint8Array(view.buffer);
  if (bytes[0]! & 0x80) {
    for (let index = 0; index < 8; index += 1) bytes[index] = ~bytes[index]! & 0xff;
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }
  out.push(...bytes);
}

function pushString(value: string, field: string, out: number[]): void {
  const bytes = encoder.encode(value);
  if (bytes.length > OBJECT_INDEX_STRING_MAX_BYTES) {
    throw new ObjectError(
      "object.invalid_index_value",
      `Indexed field "${field}" holds more than ${OBJECT_INDEX_STRING_MAX_BYTES} bytes.`,
    );
  }
  for (const byte of bytes) {
    if (byte === 0x00) out.push(0x00, 0xff);
    else out.push(byte);
  }
  out.push(0x00, 0x01);
}

/** The scalar an indexed field holds; objects and arrays are refused. */
export function indexScalar(value: unknown, field: string): IndexScalar {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ObjectError("object.invalid_index_value", `Indexed field "${field}" must be a finite number.`);
    }
    return value;
  }
  throw new ObjectError(
    "object.invalid_index_value",
    `Indexed field "${field}" must be a string, number, boolean or null.`,
  );
}

function pushComponent(value: IndexScalar, field: string, out: number[]): void {
  if (value === null) out.push(TAG_NULL);
  else if (value === false) out.push(TAG_FALSE);
  else if (value === true) out.push(TAG_TRUE);
  else if (typeof value === "number") {
    out.push(TAG_NUMBER);
    pushNumber(value, out);
  } else {
    out.push(TAG_STRING);
    pushString(value, field, out);
  }
}

function toHex(bytes: readonly number[]): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Lowercase hex of the encoded tuple; `fields` name the components for error messages. */
export function encodeIndexTuple(values: readonly IndexScalar[], fields: readonly string[]): string {
  const bytes: number[] = [];
  values.forEach((value, index) => pushComponent(value, fields[index] ?? `#${index}`, bytes));
  if (bytes.length > OBJECT_INDEX_TUPLE_MAX_BYTES) {
    throw new ObjectError(
      "object.invalid_index_value",
      `The indexed values of ${fields.join(", ")} are longer than ${OBJECT_INDEX_TUPLE_MAX_BYTES} bytes together.`,
    );
  }
  return toHex(bytes);
}

/**
 * The exclusive upper bound of every encoding that starts with `prefixHex`:
 * hex digits all sort below `g` in every collation.
 */
export function indexPrefixUpperBound(prefixHex: string): string {
  return `${prefixHex}g`;
}
