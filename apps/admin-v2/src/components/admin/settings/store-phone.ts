/**
 * Accepts any spacing, dashes, +880/880 and Bangla digits; a Bangladeshi
 * mobile number comes back as 01XXXXXXXXX. Anything else is kept as typed.
 */
export function normalizeStorePhone(raw: string): string {
  const latin = raw.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6)).trim();
  const compact = latin.replace(/[\s\-().]/g, "");
  const match = /^(?:\+?880|0)?(1[3-9]\d{8})$/.exec(compact);
  return match ? `0${match[1]}` : latin;
}
