// Where the footer's one "Track your order" link goes: the store's Help
// column when it has one, else the bottom row. A menu that already links
// /track-order keeps its own link and no second one is added.
import type { FooterMenuLink } from "@/lib/api";

export const TRACK_ORDER_PATH = "/track-order";

const HELP_MENU_TITLE = /^(?:help|support|customer\s+(?:care|service|support)|সাহায্য|সহায়তা)(?![a-z])/i;

function linksTrackOrder(links: readonly FooterMenuLink[]): boolean {
  return links.some((link) =>
    (link.href ?? "").split(/[?#]/, 1)[0]!.replace(/\/+$/, "") === TRACK_ORDER_PATH
    || linksTrackOrder(link.subMenu ?? []));
}

export function placeTrackOrderLink<Menu extends { title: string; links: FooterMenuLink[] }>(
  menus: Menu[],
  label: string,
): { menus: Menu[]; inBottomRow: boolean } {
  if (menus.some((menu) => linksTrackOrder(menu.links))) return { menus, inBottomRow: false };
  const help = menus.findIndex((menu) => HELP_MENU_TITLE.test(menu.title.trim()));
  if (help < 0) return { menus, inBottomRow: true };
  return {
    menus: menus.map((menu, index) =>
      index === help ? { ...menu, links: [...menu.links, { title: label, href: TRACK_ORDER_PATH }] } : menu),
    inBottomRow: false,
  };
}
