/**
 * One stable colour per person (avatar, field ring, name tag), from their
 * staff id: the same person has the same colour in every browser. Tokens:
 * `--presence-1` … `--presence-6` in styles/global.css.
 */
import { getLocale } from "~/i18n";

export const PRESENCE_FILL = [
  "bg-presence-1",
  "bg-presence-2",
  "bg-presence-3",
  "bg-presence-4",
  "bg-presence-5",
  "bg-presence-6",
] as const;

export const PRESENCE_RING = [
  "ring-presence-1",
  "ring-presence-2",
  "ring-presence-3",
  "ring-presence-4",
  "ring-presence-5",
  "ring-presence-6",
] as const;

/** A small stable hash of the staff id (FNV-1a), into the palette. */
export function presenceColour(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % PRESENCE_FILL.length;
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
