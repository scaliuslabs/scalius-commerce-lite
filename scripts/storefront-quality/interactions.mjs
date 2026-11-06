/** Invalid audit states cannot be accepted as measurements of the intended UI. */
export const REQUIRED_STATE_RULES = new Set(["interaction", "focus-missing"]);
const TIMEOUT = 5_000;
const selectorOf = (action) => action.click ?? action.select ?? action.type ?? action.expectInside ?? action.expectAboveFold ?? action.expectSameRow?.join(" + ") ?? action.expectTouching?.join(" over ");

/** The first visible match and its box. */
async function box(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible", timeout: TIMEOUT });
  const rect = await target.boundingBox();
  if (!rect) throw new Error(`${selector} has no box.`);
  return { target, rect };
}

/** A layout expectation: an element inside its container, on the first screen, or two on one row. Throws what is wrong. */
async function checkLayout(page, action) {
  if (action.expectAboveFold !== undefined) {
    const { rect } = await box(page, action.expectAboveFold);
    const fold = Math.min(page.viewportSize()?.height ?? 0, action.fold ?? Infinity);
    if (rect.y >= fold) throw new Error(`${action.expectAboveFold} starts at ${Math.round(rect.y)}px, below the first screen (${fold}px).`);
    return;
  }
  if (action.expectInside !== undefined) {
    const inner = await box(page, action.expectInside);
    const outer = await box(page, action.container);
    const nested = await inner.target.evaluate((element, container) => element.closest(container) !== null, action.container);
    const { x, y, width, height } = inner.rect;
    const o = outer.rect;
    // Half a pixel for subpixel rounding.
    const within = x >= o.x - 0.5 && y >= o.y - 0.5 && x + width <= o.x + o.width + 0.5 && y + height <= o.y + o.height + 0.5;
    if (!nested || !within) throw new Error(`${action.expectInside} sits outside ${action.container} (${nested ? "its box" : "its element"}).`);
    return;
  }
  if (action.expectTouching !== undefined) {
    // The upper one reaches the lower one (they meet or overlap): nothing of the page shows between them.
    const [upper, lower] = action.expectTouching;
    const a = (await box(page, upper)).rect;
    const b = (await box(page, lower)).rect;
    const gap = b.y - (a.y + a.height);
    if (gap > 0.5) throw new Error(`${upper} ends ${Math.round(gap)}px above ${lower}: the page shows between them.`);
    return;
  }
  const [first, second] = action.expectSameRow;
  const a = (await box(page, first)).rect;
  const b = (await box(page, second)).rect;
  const centreIn = (r, s) => r.y + r.height / 2 >= s.y && r.y + r.height / 2 <= s.y + s.height;
  if (!centreIn(a, b) && !centreIn(b, a)) throw new Error(`${first} and ${second} sit on different rows.`);
}
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
      if (action.expectInside !== undefined || action.expectSameRow !== undefined || action.expectAboveFold !== undefined || action.expectTouching !== undefined) {
        await checkLayout(page, action);
        steps.push({ index, selector, status: "passed" });
        continue;
      }
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
