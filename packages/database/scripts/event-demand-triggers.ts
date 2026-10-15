// Subscription changes are rare: recompute their small union in the same
// transaction, while domain writes only probe the topic-filter primary key.

export const EVENT_DEMAND_CREATE_SQL = "CREATE TABLE `event_demand` (`filter` text PRIMARY KEY NOT NULL);";

const activeFilters = `SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active'`;

const refreshStatements = [
  `INSERT INTO event_demand (filter) SELECT filter FROM (${activeFilters}) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING`,
  `DELETE FROM event_demand WHERE filter NOT IN (${activeFilters})`,
];

const sources = [
  { name: "webhook_insert", table: "webhook_subscriptions", event: "INSERT", guard: "NEW.status = 'active'" },
  { name: "webhook_update", table: "webhook_subscriptions", event: "UPDATE OF status, topics", guard: "OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics" },
  { name: "webhook_delete", table: "webhook_subscriptions", event: "DELETE", guard: "OLD.status = 'active'" },
  { name: "plugin_insert", table: "plugin_registrations", event: "INSERT", guard: "NEW.kind = 'event'" },
  { name: "plugin_update", table: "plugin_registrations", event: "UPDATE OF kind, name, plugin_id", guard: "OLD.kind = 'event' OR NEW.kind = 'event'" },
  { name: "plugin_delete", table: "plugin_registrations", event: "DELETE", guard: "OLD.kind = 'event'" },
  { name: "installation_status", table: "plugin_installations", event: "UPDATE OF status", guard: "OLD.status IS NOT NEW.status" },
] as const;

/** D1/Turso: one statement per trigger, including the bootstrap from existing subscriptions. */
export function eventDemandSqliteStatements(): string[] {
  return [
    ...refreshStatements.map((statement) => `${statement};`),
    ...sources.flatMap((source) => refreshStatements.map((statement, index) =>
      `CREATE TRIGGER demand_${source.name}_${index} AFTER ${source.event} ON ${source.table}\nWHEN ${source.guard}\nBEGIN\n  ${statement};\nEND;`,
    )),
  ];
}

/** PostgreSQL serializes subscription changes, so concurrent subscribers cannot erase each other's demand. */
export function eventDemandPostgresTrigger(name: string): string | undefined {
  for (const source of sources) {
    for (let index = 0; index < refreshStatements.length; index += 1) {
      if (name !== `demand_${source.name}_${index}`) continue;
      const guard = source.guard.replaceAll(" IS NOT ", " IS DISTINCT FROM ");
      return `CREATE OR REPLACE FUNCTION scalius_compat."${name}_fn"()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $trigger_function$\nBEGIN\n  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;\n  ${refreshStatements[index]};\n  RETURN NULL;\nEND\n$trigger_function$;\nCREATE TRIGGER "${name}" AFTER ${source.event} ON ${source.table}\nFOR EACH ROW WHEN (${guard}) EXECUTE FUNCTION scalius_compat."${name}_fn"();`;
    }
  }
  return undefined;
}
