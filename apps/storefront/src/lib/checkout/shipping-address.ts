export const MIN_SHIPPING_ADDRESS_LENGTH = 10;

export function getShippingAddressError(value: string): string | null {
  const address = value.trim();
  if (!address) return "Enter your delivery address.";
  if (address.length < MIN_SHIPPING_ADDRESS_LENGTH) {
    return `Enter a complete delivery address (at least ${MIN_SHIPPING_ADDRESS_LENGTH} characters).`;
  }
  return null;
}
