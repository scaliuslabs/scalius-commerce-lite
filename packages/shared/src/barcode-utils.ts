/**
 * Barcode utilities for generating and validating EAN-13 barcodes.
 * Uses the 200-299 prefix range reserved for internal/store use per GS1 standards,
 * so no GS1 registration is needed.
 */

export function generateEAN13(): string {
  const prefix = "200";
  const random = randomDecimalDigits(9);
  const digits = prefix + random;
  const checkDigit = calculateEAN13CheckDigit(digits);
  return digits + checkDigit;
}

function randomDecimalDigits(length: number): string {
  let result = "";
  const bytes = new Uint8Array(Math.max(16, length * 2));

  while (result.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 250) continue;
      const digit = byte - Math.floor(byte / 10) * 10;
      result += String.fromCharCode(48 + digit);
      if (result.length === length) break;
    }
  }

  return result;
}

export function calculateEAN13CheckDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits[i] ?? '0') * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

export function validateEAN13(barcode: string): boolean {
  if (!/^\d{13}$/.test(barcode)) return false;
  const check = calculateEAN13CheckDigit(barcode.slice(0, 12));
  return check === barcode[12];
}
