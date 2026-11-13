// Test support: the storefront's React islands ship no runtime class merger
// (tailwind-merge would ride on the first add to cart and on search), so each
// class list they draw must be one the merge would leave as it is: what the
// buyer saw when the merge ran. It does not prove that no two classes set one
// CSS property (tailwind-merge misses logical and physical pairs such as
// `ms-2 ml-4`, and `inset-y-0 top-auto`); keep those out by hand.
import { cn } from "@scalius/shared/utils";

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean).sort();

/** Each drawn class list under `root` that tailwind-merge would change, with the classes it would drop. */
export function classConflicts(root: ParentNode = document.body): string[] {
  const found: string[] = [];
  for (const element of root.querySelectorAll<Element>("[class]")) {
    const classes = element.getAttribute("class") ?? "";
    const merged = tokens(cn(classes));
    const drawn = tokens(classes);
    if (merged.join(" ") !== drawn.join(" ")) {
      found.push(`<${element.tagName.toLowerCase()}> drops ${drawn.filter((name) => !merged.includes(name)).join(", ")} from "${classes}"`);
    }
  }
  return found;
}
