/** How a delivery contact is shown on receipts and staff lists: "r•••@example.com", "01•••••678". */
export function maskGiftCardContact(method: "email" | "phone", target: string): string {
    if (method === "email") {
        const [local = "", domain = ""] = target.split("@");
        return `${local.slice(0, 1)}•••@${domain}`;
    }
    const digits = target.replace(/\D/g, "");
    const local = digits.startsWith("880") ? `0${digits.slice(3)}` : digits;
    return `${local.slice(0, 2)}•••••${local.slice(-3)}`;
}

export function maskGiftCardRecipient(recipient: { email: string | null; phone: string | null }): string | null {
    if (recipient.email) return maskGiftCardContact("email", recipient.email);
    if (recipient.phone) return maskGiftCardContact("phone", recipient.phone);
    return null;
}
