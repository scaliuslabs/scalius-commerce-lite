type NamedCheckoutControl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Returns the successful named control a native form would submit.
 * Radio groups need the checked member, not the first element in DOM order.
 */
export function findNamedCheckoutControl(
  root: ParentNode,
  name: string,
): NamedCheckoutControl | null {
  const controls = root.querySelectorAll<NamedCheckoutControl>(
    `[name="${name}"]`,
  );
  const first = controls[0];
  if (!first) return null;

  if (first instanceof HTMLInputElement && first.type === "radio") {
    return Array.from(controls).find(
      (control): control is HTMLInputElement =>
        control instanceof HTMLInputElement &&
        control.type === "radio" &&
        control.checked,
    ) ?? null;
  }

  return first;
}

export function readNamedFormControlValue(
  root: ParentNode,
  name: string,
): string | undefined {
  return findNamedCheckoutControl(root, name)?.value;
}
