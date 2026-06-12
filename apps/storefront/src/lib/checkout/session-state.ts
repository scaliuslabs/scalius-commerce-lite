export function clearCheckoutSession(): void {
  try {
    sessionStorage.removeItem("scalius_checkout_data");
    sessionStorage.removeItem("scalius_checkout_gateways");
  } catch {
    // ignore storage access errors
  }
}
