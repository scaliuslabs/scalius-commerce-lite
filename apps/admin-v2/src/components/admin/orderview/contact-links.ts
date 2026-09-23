/** One-tap Call, WhatsApp and SMS links for a customer's phone. */
export function customerContactLinks(phone: string): { call: string; sms: string; whatsapp: string | null } {
  const dialable = phone.replace(/[^\d+]/g, "");
  const digits = phone.replace(/\D/g, "");
  // wa.me wants the international number without "+": 01XXXXXXXXX → 8801XXXXXXXXX.
  const whatsapp = /^01\d{9}$/.test(digits)
    ? `88${digits}`
    : /^1\d{9}$/.test(digits)
      ? `880${digits}`
      : digits.length >= 8 ? digits : null;
  return {
    call: `tel:${dialable}`,
    sms: `sms:${dialable}`,
    whatsapp: whatsapp ? `https://wa.me/${whatsapp}` : null,
  };
}
