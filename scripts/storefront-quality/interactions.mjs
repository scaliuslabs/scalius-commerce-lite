/** Invalid audit states cannot be accepted as measurements of the intended UI. */
export const REQUIRED_STATE_RULES = new Set(["interaction", "focus-missing"]);
const TIMEOUT = 5_000;
const selectorOf = (action) => action.click ?? action.select ?? action.type;
const excluded = (action, width) => action.maxWidth !== undefined && width >= action.maxWidth;

/**
 * Establish the fixture's required state before checking it. A successful
 * click alone says nothing about whether a drawer or suggestion list opened.
 * @param {import('playwright').Page} page
 * @param {import('../../apps/storefront/src/gallery/entries').GalleryInteraction[]} actions
 * @param {number} width
 */
export async function runInteractions(page, actions, width) {
  const steps = [];
  for (const [index, action] of actions.entries()) {
    const selector = selectorOf(action);
    if (excluded(action, width)) {
      steps.push({ index, selector, status: "not-applicable" });
      continue;
    }
    try {
      if (action.click !== undefined && !action.expectVisible) throw new Error("Click needs an expected visible state.");
      const target = page.locator(selector).first();
      await target.waitFor({ state: "visible", timeout: TIMEOUT });
      if (action.click !== undefined) await target.click({ timeout: TIMEOUT });
      else if (action.select !== undefined) {
        await target.selectOption(action.value, { timeout: TIMEOUT });
        if (await target.inputValue() !== action.value) throw new Error("Selected value did not persist.");
      } else {
        await target.fill("", { timeout: TIMEOUT });
        await target.pressSequentially(action.text, { delay: 30, timeout: TIMEOUT });
        if (await target.inputValue() !== action.text) throw new Error("Typed value did not persist.");
      }
      if (action.expectVisible) await page.locator(action.expectVisible).first().waitFor({ state: "visible", timeout: TIMEOUT });
      steps.push({ index, selector, status: "passed" });
    } catch (error) {
      const message = `Required interaction ${index + 1} (${selector}) failed: ${String(error.message ?? error).slice(0, 300)}`;
      steps.push({ index, selector, status: "failed", message });
      for (let rest = index + 1; rest < actions.length; rest += 1) {
        steps.push({ index: rest, selector: selectorOf(actions[rest]), status: excluded(actions[rest], width) ? "not-applicable" : "not-run" });
      }
      return { steps, failure: { rule: "interaction", source: "harness", impact: "critical", gating: true, message, count: 1, nodes: [selector] } };
    }
  }
  return { steps, failure: null };
}
