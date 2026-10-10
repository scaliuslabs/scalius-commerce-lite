/**
 * One stable colour per person (avatar, field ring, name tag), from their
 * staff id: the same person has the same colour in every browser. Tokens:
 * `--presence-1` … `--presence-6` and `--presence-foreground` in
 * styles/global.css (both themes). An element takes the person's colour as
 * the `--presence` custom property (`presenceVar`) and paints with
 * `bg-(--presence)`, `ring-(--presence)` and `text-(--presence-foreground)`:
 * three utilities instead of one per colour.
 */
import { getLocale } from "~/i18n";

const PRESENCE_COLOURS = 6;

/** A small stable hash of the staff id (FNV-1a), into the palette. */
export function presenceColour(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PRESENCE_COLOURS;
}

/** The person's colour, for `style={{ "--presence": presenceVar(id) }}`. */
export function presenceVar(id: string): string {
  return `var(--presence-${presenceColour(id) + 1})`;
}

/** Up to two letters from a display name, for the avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0]!)[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1]!)[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase(getLocale());
}

/** The first word of a display name, for a field's name tag. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || "?";
}
