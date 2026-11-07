// Who did something, as every dashboard screen names them: a staff member by
// name, a removed account as "Former admin", an app by its display name, and
// the system as "System". The API records an app's writes as `app:<plugin id>`
// (apps/api/src/routes/admin/request-actor.ts) or, where a column references a
// staff account, as no staff member; these readers turn each response's shape
// into one `Actor`, and `formatActor` words it. Screens never read an actor's
// name field themselves (actor-display.test.ts): they pass the record here and
// render the result with `ActorName` or `useActorText`
// (components/admin/shared/ActorName.tsx).

/** Who did something. */
export type Actor =
  | { kind: "staff"; name: string }
  /** A staff account that no longer exists (its name went with it). */
  | { kind: "former-staff" }
  | { kind: "app"; appId: string }
  | { kind: "system" };

/** What the dashboard knows about an app's name. */
export type AppName =
  | { status: "installed"; name: string }
  /** No longer installed; the name it had. */
  | { status: "removed"; name: string }
  /** The store has no app by this id. */
  | { status: "gone" }
  /** Not known here: the viewer cannot see Apps, or the apps are still loading. */
  | { status: "unknown" };

/** The words `formatActor` needs (`actorMessages`, i18n/actor.ts). */
export type ActorMessageKey = "formerAdmin" | "system" | "unknownApp" | "removedApp" | "removedAppNamed";
export type ActorTranslate = (key: ActorMessageKey, vars?: Record<string, string | number>) => string;

const APP_PREFIX = "app:";
const SYSTEM: Actor = { kind: "system" };
const FORMER: Actor = { kind: "former-staff" };

/** The plugin id of a recorded `app:<id>` actor, or null for anyone else. */
export function recordedAppId(id: string | null | undefined): string | null {
  return id?.startsWith(APP_PREFIX) && id.length > APP_PREFIX.length ? id.slice(APP_PREFIX.length) : null;
}

/** A staff member by the name the API joined, or a removed account when it has none. */
export function staffActor(name: string | null | undefined): Actor {
  const shown = name?.trim();
  return shown ? { kind: "staff", name: shown } : FORMER;
}

/**
 * An actor recorded by id: `app:<plugin id>` is an app, any other id a staff
 * member (or a removed account when the API found no name), and none the system.
 */
export function actorFromId(id: string | null | undefined, staffName: string | null | undefined): Actor {
  if (!id) return SYSTEM;
  const appId = recordedAppId(id);
  return appId ? { kind: "app", appId } : staffActor(staffName);
}

/**
 * An actor the API sent as a type and a name: stock history, a stock
 * document's receipts and activity, a gift card's ledger. An app's name is its
 * id there; a ledger that records an app as the system carries it in `actorId`.
 */
export function typedActor(record: { actorType: string; actorName?: string | null; actorId?: string | null }): Actor {
  const appId = recordedAppId(record.actorId);
  if (appId) return { kind: "app", appId };
  switch (record.actorType) {
    case "app":
      return record.actorName ? { kind: "app", appId: record.actorName } : SYSTEM;
    case "admin":
    case "staff":
      return staffActor(record.actorName);
    case "former_admin":
      return FORMER;
    default:
      return SYSTEM;
  }
}

/** Who published a theme version (or the live theme last). */
export function themePublisher(version: { publishedBy: string | null; publishedByName: string | null }): Actor {
  return actorFromId(version.publishedBy, version.publishedByName);
}

/** Whose restore or discard kept a theme restore point. */
export function restorePointAuthor(point: { createdBy: string | null; createdByName: string | null }): Actor {
  return actorFromId(point.createdBy, point.createdByName);
}

/** Who saved the shared theme draft last; null when nobody has (the editor then names no one). */
export function draftSaver(draft: { updatedBy?: string | null; updatedByName?: string | null }): Actor | null {
  if (draft.updatedBy) return actorFromId(draft.updatedBy, draft.updatedByName);
  return draft.updatedByName ? staffActor(draft.updatedByName) : null;
}

/**
 * Who wrote an order timeline line. `actorId` (`app:<id>` for an app) names an
 * app or a removed account; without it, a line with no staff name has no actor.
 */
export function timelineActor(event: { actorName: string | null; actorId?: string | null }): Actor | null {
  if (event.actorId) return actorFromId(event.actorId, event.actorName);
  return event.actorName?.trim() ? staffActor(event.actorName) : null;
}

/** Who made a customer record change; the buyer's own changes are worded by the customer page. */
export function customerChangeAuthor(author: { kind: string; name: string | null; appId?: string | null }): Actor | "buyer" {
  if (author.kind === "buyer") return "buyer";
  if (author.kind === "app" && author.appId) return { kind: "app", appId: author.appId };
  if (author.kind === "staff") return staffActor(author.name);
  return SYSTEM;
}

/** Who changed a marketing consent; the customer's own changes are worded by the marketing card. */
export function consentEventActor(event: { actor: string; actorName: string | null; appId?: string | null }): Actor | "buyer" {
  if (event.actor === "buyer") return "buyer";
  if (event.actor === "plugin") {
    const appId = event.appId ?? event.actorName;
    return appId ? { kind: "app", appId } : SYSTEM;
  }
  if (event.actor === "staff") return staffActor(event.actorName);
  return SYSTEM;
}

/**
 * Who issued a manual gift card: the staff member the card names, else the
 * ledger's issue line (an app issues as `system`/`app:<id>`). Null when
 * neither says.
 */
export function giftCardIssuer(
  card: { issuedBy: { id: string; name: string } | null },
  issue: { actorType: string; actorName?: string | null; actorId?: string | null } | undefined,
): Actor | null {
  if (card.issuedBy) return staffActor(card.issuedBy.name);
  if (!issue || issue.actorType === "customer") return null;
  const actor = typedActor(issue);
  return actor.kind === "system" ? null : actor;
}

/** Who connected an AI agent: always a staff member, or their removed account. */
export function connectionOwner(connection: { ownerName: string | null }): Actor {
  return staffActor(connection.ownerName);
}

/** The app ids among these actors, once each (what the app name lookup needs). */
export function actorAppIds(actors: Iterable<Actor | null | undefined | "buyer">): string[] {
  const ids = new Set<string>();
  for (const actor of actors) if (actor && actor !== "buyer" && actor.kind === "app") ids.add(actor.appId);
  return [...ids];
}

/** The words for an actor, in the dashboard's language. */
export function formatActor(actor: Actor, t: ActorTranslate, appName: (appId: string) => AppName): string {
  switch (actor.kind) {
    case "staff":
      return actor.name;
    case "former-staff":
      return t("formerAdmin");
    case "system":
      return t("system");
    case "app": {
      const app = appName(actor.appId);
      if (app.status === "installed") return app.name;
      if (app.status === "removed") return t("removedAppNamed", { name: app.name });
      return t(app.status === "gone" ? "removedApp" : "unknownApp");
    }
  }
}
