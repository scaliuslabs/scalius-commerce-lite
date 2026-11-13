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
    viaAgent: "{staff} via {connection}",
    viaAgentClient: "{staff} via {connection} ({client})",
    viaAgentApproved: "{staff} via {connection}, approved in the dashboard",
    viaAgentClientApproved: "{staff} via {connection} ({client}), approved in the dashboard",
    unnamedAgent: "an AI assistant",
  },
  bn: {
    formerAdmin: "সাবেক অ্যাডমিন",
    system: "সিস্টেম",
    unknownApp: "অজানা অ্যাপ",
    removedApp: "সরিয়ে ফেলা অ্যাপ",
    removedAppNamed: "{name} (সরিয়ে ফেলা অ্যাপ)",
    viaAgent: "{connection}-এর মাধ্যমে {staff}",
    viaAgentClient: "{connection} ({client})-এর মাধ্যমে {staff}",
    viaAgentApproved: "{connection}-এর মাধ্যমে {staff}, ড্যাশবোর্ডে অনুমোদিত",
    viaAgentClientApproved: "{connection} ({client})-এর মাধ্যমে {staff}, ড্যাশবোর্ডে অনুমোদিত",
    unnamedAgent: "একটি এআই অ্যাসিস্ট্যান্ট",
  },
});
