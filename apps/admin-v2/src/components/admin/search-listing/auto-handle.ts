import { handleFromText, type HandleResource } from "@scalius/shared/handle";

/**
 * The handle the server makes from a new item's name; empty until there is a
 * name. Apart from the card so a form can derive it without loading the card.
 */
export function autoHandleFor(name: string, resource: HandleResource): string {
  return name.trim() ? handleFromText(name, resource) : "";
}
