import {
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
} from "@scalius/shared/assistant-computer";

import { allNavSections } from "../../layout/AdminNav";

interface AdminNavigationDestination {
  labels: string[];
  path: string;
}

const ADMIN_NAVIGATION_DESTINATIONS = buildAdminNavigationDestinations();

/**
 * `goto` is the one computer verb that can move the merchant without first
 * observing a visible control. Treat the signed tool output as authenticity,
 * not consent: the latest preceding user turn must be a single explicit
 * navigation request for this exact catalog destination.
 */
export function isDirectAdminNavigationAuthorized(
  latestUserMessage: string | undefined,
  program: string,
): boolean {
  const parsed = parseScaliusComputerProgram(program);
  if (!parsed.ok) return false;
  const command = parsed.commands[0];
  if (!command || command.name !== "goto") return true;
  if (!latestUserMessage) return false;

  const route = normalizeScaliusComputerRoute(command.route);
  if (!route) return false;
  const url = new URL(route, "https://admin.invalid");
  if (url.search || url.hash) return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const destination = ADMIN_NAVIGATION_DESTINATIONS.get(pathname);
  if (!destination || route !== destination.path) return false;

  const requested = directAdminNavigationDestination(latestUserMessage);
  if (!requested) return false;
  const requestedTokens = canonicalDestinationTokens(requested);
  if (requestedTokens.length === 0) return false;

  return [destination.path.replace(/^\/admin\/?/u, ""), ...destination.labels]
    .map(canonicalDestinationTokens)
    .some(
      (candidate) =>
        candidate.length > 0 && candidate.join("|") === requestedTokens.join("|"),
    );
}

function buildAdminNavigationDestinations(): Map<
  string,
  AdminNavigationDestination
> {
  const destinations = new Map<string, AdminNavigationDestination>();
  for (const section of allNavSections) {
    for (const item of section.items) {
      retainDestination(destinations, item.href, item.name);
      for (const subItem of item.subItems ?? []) {
        retainDestination(destinations, subItem.href, subItem.name);
      }
    }
  }
  return destinations;
}

function retainDestination(
  destinations: Map<string, AdminNavigationDestination>,
  path: string,
  label: string,
): void {
  const current = destinations.get(path);
  if (current) {
    if (!current.labels.includes(label)) current.labels.push(label);
    return;
  }
  destinations.set(path, { path, labels: [label] });
}

function directAdminNavigationDestination(value: string): string | null {
  const message = value.trim();
  if (
    !message ||
    /[,;]/u.test(message) ||
    /\b(?:and|or|then|also|either|whichever|maybe|plus|with)\b/iu.test(message)
  ) {
    return null;
  }

  const command =
    "(?:open|navigate(?:\\s+me)?\\s+to|go\\s+to|visit|show\\s+me|take\\s+me\\s+to|send\\s+me\\s+to|jump\\s+to)";
  const patterns = [
    new RegExp(
      `^(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
      "iu",
    ),
    new RegExp(
      `^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const destination = pattern.exec(message)?.[1]?.trim();
    if (destination) return destination;
  }
  return null;
}

function canonicalDestinationTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 &&
        token !== "admin" &&
        token !== "page" &&
        token !== "screen" &&
        token !== "section",
    )
    .map(singularDestinationToken)
    .sort();
}

function singularDestinationToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(?:xes|sses|shes|ches|zes)$/u.test(token)) return token.slice(0, -2);
  return token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}
