/**
 * Whether the cart page places cash on delivery itself, with no payment step:
 * the buyer sees only the methods they can use, and a step offering one
 * choice is no step.
 *
 * - A store whose only method is cash always places it here.
 * - A store that takes cash among other methods places it here once this
 *   buyer's quote (`allowedPaymentMethods`, which never gives a guest the
 *   invoice) leaves cash alone. Before a quote the page cannot know, and
 *   keeps the step.
 * - A buyer who brings a gift card goes to the payment step, where its field is.
 */
export function codPaymentStep(input: {
  storeCodOnly: boolean;
  /** The store takes cash and asks no advance (`canPlaceCashHere`). */
  codPlaceable: boolean;
  giftCardChosen: boolean;
  /** The current quote's methods for this buyer; null before a quote. */
  quotedMethods: readonly string[] | null;
}): boolean {
  if (input.giftCardChosen) return false;
  if (input.storeCodOnly) return true;
  if (!input.codPlaceable || !input.quotedMethods) return false;
  return input.quotedMethods.length === 1 && input.quotedMethods[0] === "cod";
}
