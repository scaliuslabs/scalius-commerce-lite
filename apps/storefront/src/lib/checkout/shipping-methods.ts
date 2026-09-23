/**
 * Vanilla enhancement for the server-rendered delivery options on /cart
 * (components/checkout/CheckoutShippingMethods.astro). Other cart code reads
 * the chosen method from `window.lastShippingEventDetail` and the
 * `shippingLocationChange` event.
 */

export interface ShippingMethodDetail {
  id: string;
  fee: number;
  name: string;
}

export function enhanceShippingMethods(
  root: ParentNode,
  options: {
    readDraftMethod: () => string | undefined;
    isFeeWaived: () => boolean;
    signal?: AbortSignal;
  },
): { refreshFees(): void } | null {
  const container = root.querySelector<HTMLElement>("[data-shipping-methods]");
  if (!container) return null;
  const controls = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[name="shippingLocation"]'),
  );
  if (controls.length === 0) return null;

  const emit = () => {
    const control = controls.find(
      (candidate) => candidate.type === "hidden" || candidate.checked,
    );
    if (!control) return;
    const detail: ShippingMethodDetail = {
      id: control.value,
      fee: Number(control.dataset.fee) || 0,
      name: control.dataset.name || "",
    };
    window.lastShippingEventDetail = detail;
    window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail }));
  };

  const refreshFees = () => {
    const waived = options.isFeeWaived();
    const freeText = container.dataset.freeText || "";
    const waivedText = container.dataset.waivedText || "";
    for (const label of container.querySelectorAll<HTMLElement>("[data-fee-label]")) {
      const control = label.closest("label")?.querySelector("input") ?? controls[0];
      const baseLabel = label.dataset.feeLabel || "";
      const waivesFee = waived && Number(control?.dataset.fee) > 0;
      label.textContent = waivesFee ? freeText : baseLabel;
      if (waivesFee) label.title = waivedText.replace("{fee}", baseLabel);
      else label.removeAttribute("title");
    }
  };

  container.addEventListener("change", emit, { signal: options.signal });

  const draftMethod = options.readDraftMethod();
  const draftControl = controls.find((control) => control.value === draftMethod);
  if (draftControl?.type === "radio") draftControl.checked = true;
  refreshFees();
  emit();
  return { refreshFees };
}
