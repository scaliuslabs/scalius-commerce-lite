import { defineMessages } from "./index";

/**
 * Sales channel names and the products list's channel column and filter
 * (docs/MARKETS-DESIGN.md D6): small, so the list and the product editor
 * load it with their first screen. Built-in channels are named here
 * (`channel.<id>`); an app's channel keeps its own name.
 */
export const salesChannelNamesMessages = defineMessages({
  en: {
    "channel.sc_online_store": "Online store",
    "channel.sc_google": "Google",
    "channel.sc_meta": "Facebook and Instagram",
    "channel.sc_agents": "AI agents",
    columnChannels: "Channels",
    channelsCount: "{count} of {total}",
    channelsNone: "None",
    filterChannel: "Filter by sales channel",
    channelLabel: "Sales channel",
    allChannels: "All sales channels",
    onChannel: "On {name}",
    notOnChannel: "Not on {name}",
  },
  bn: {
    "channel.sc_online_store": "অনলাইন স্টোর",
    "channel.sc_google": "Google",
    "channel.sc_meta": "Facebook ও Instagram",
    "channel.sc_agents": "AI এজেন্ট",
    columnChannels: "চ্যানেল",
    channelsCount: "{total}টির মধ্যে {count}টি",
    channelsNone: "কোনোটিতে নয়",
    filterChannel: "সেলস চ্যানেল দিয়ে ফিল্টার করুন",
    channelLabel: "সেলস চ্যানেল",
    allChannels: "সব সেলস চ্যানেল",
    onChannel: "{name}-এ আছে",
    notOnChannel: "{name}-এ নেই",
  },
});

export type SalesChannelNamesMessageKey = keyof typeof salesChannelNamesMessages.en;
