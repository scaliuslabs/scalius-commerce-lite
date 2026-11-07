import { defineMessages } from "./index";

/**
 * How the dashboard names who did something (`formatActor`, lib/actor.ts):
 * the only place a removed account, the system or an app the store no longer
 * knows is worded (actor-display.test.ts).
 */
export const actorMessages = defineMessages({
  en: {
    formerAdmin: "Former admin",
    system: "System",
    unknownApp: "Unknown app",
    removedApp: "Removed app",
    removedAppNamed: "{name} (removed app)",
  },
  bn: {
    formerAdmin: "সাবেক অ্যাডমিন",
    system: "সিস্টেম",
    unknownApp: "অজানা অ্যাপ",
    removedApp: "সরিয়ে ফেলা অ্যাপ",
    removedAppNamed: "{name} (সরিয়ে ফেলা অ্যাপ)",
  },
});
