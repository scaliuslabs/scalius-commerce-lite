/**
 * The Lucide icons the cart drawer draws, in the markup lucide-react draws
 * (`lucide-svg.test.ts` keeps both equal to the installed package), without
 * its runtime: the drawer loads with the first add to cart, where that
 * runtime was 1 KiB gzip for eight icons of paths alone.
 */
import { createElement, type SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "className"> & { className: string };

/** An icon of `paths`, its class lucide-react's (`lucide-<name>`, Trash2's two of them). */
function icon(name: string, ...paths: string[]) {
  return ({ className, strokeWidth = 2, ...rest }: IconProps) =>
    createElement(
      "svg",
      { xmlns: "http://www.w3.org/2000/svg", width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", className: `lucide ${name} ${className}`, "aria-hidden": "true", ...rest },
      paths.map((d) => createElement("path", { key: d, d })),
    );
}

export const ArrowRight = icon("lucide-arrow-right", "M5 12h14", "m12 5 7 7-7 7");
export const Check = icon("lucide-check", "M20 6 9 17l-5-5");
export const ChevronDown = icon("lucide-chevron-down", "m6 9 6 6 6-6");
export const Minus = icon("lucide-minus", "M5 12h14");
export const Plus = icon("lucide-plus", "M5 12h14", "M12 5v14");
export const ShoppingBag = icon(
  "lucide-shopping-bag",
  "M16 10a4 4 0 0 1-8 0",
  "M3.103 6.034h17.794",
  "M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z",
);
export const Trash2 = icon(
  "lucide-trash2 lucide-trash-2",
  "M10 11v6",
  "M14 11v6",
  "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  "M3 6h18",
  "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
);
export const X = icon("lucide-x", "M18 6 6 18", "m6 6 12 12");
