import { defineMessages } from "./index";

/** The words around a time of day: "Just now", "41 min ago", "Today at 3:42 PM" (`~/lib/event-time`). */
export const eventTimeMessages = defineMessages({
  en: {
    justNow: "Just now",
    minutesAgo: "{count} min ago",
    todayAt: "Today at {time}",
    yesterdayAt: "Yesterday at {time}",
    dateAt: "{date} at {time}",
    dateOnAt: "{date}, {time}",
  },
  bn: {
    justNow: "এইমাত্র",
    minutesAgo: "{count} মিনিট আগে",
    todayAt: "আজ {time}",
    yesterdayAt: "গতকাল {time}",
    dateAt: "{date} {time}",
    dateOnAt: "{date}, {time}",
  },
});
