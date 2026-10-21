// Subscription changes are rare: recompute their small union in the same
// transaction, while domain writes only probe the topic-filter primary key.
//
// An app's subscriptions are demand while it holds an approved grant,
// whatever its status: a stopped, failed or update-waiting app keeps its
// events (held deliveries, released when it runs again; plugin-sdk
// README "Events"). 0155 counted active apps only; 0176
// installs this form.

export const EVENT_DEMAND_CREATE_SQL = "CREATE TABLE `event_demand` (`filter` text PRIMARY KEY NOT NULL);";

const activeFilters = `SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.grant_json IS NOT NULL`;

export const EVENT_DEMAND_REFRESH_STATEMENTS = [
  `INSERT INTO event_demand (filter) SELECT filter FROM (${activeFilters}) AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING`,
  `DELETE FROM event_demand WHERE filter NOT IN (${activeFilters})`,
] as const;

const sources = [
  { name: "webhook_insert", table: "webhook_subscriptions", event: "INSERT", guard: "NEW.status = 'active'" },
  { name: "webhook_update", table: "webhook_subscriptions", event: "UPDATE OF status, topics", guard: "OLD.status IS NOT NEW.status OR OLD.topics IS NOT NEW.topics" },
  { name: "webhook_delete", table: "webhook_subscriptions", event: "DELETE", guard: "OLD.status = 'active'" },
  { name: "plugin_insert", table: "plugin_registrations", event: "INSERT", guard: "NEW.kind = 'event'" },
  { name: "plugin_update", table: "plugin_registrations", event: "UPDATE OF kind, name, plugin_id", guard: "OLD.kind = 'event' OR NEW.kind = 'event'" },
  { name: "plugin_delete", table: "plugin_registrations", event: "DELETE", guard: "OLD.kind = 'event'" },
  { name: "installation_grant", table: "plugin_installations", event: "UPDATE OF grant_json", guard: "(OLD.grant_json IS NULL) IS NOT (NEW.grant_json IS NULL)" },
] as const;

/** The demand triggers 0155 installed that 0176 replaced by another name. */
export const RETIRED_EVENT_DEMAND_TRIGGERS = [
  { name: "demand_installation_status_0", table: "plugin_installations" },
  { name: "demand_installation_status_1", table: "plugin_installations" },
] as const;

/** Every demand trigger: its name, table and SQLite statement. */
export function eventDemandSqliteTriggers(): Array<{ name: string; table: string; sql: string }> {
  return sources.flatMap((source) => EVENT_DEMAND_REFRESH_STATEMENTS.map((statement, index) => {
    const name = `demand_${source.name}_${index}`;
    return {
      name,
      table: source.table,
      sql: `CREATE TRIGGER ${name} AFTER ${source.event} ON ${source.table}\nWHEN ${source.guard}\nBEGIN\n  ${statement};\nEND;`,
    };
  }));
}

/** D1/Turso: one statement per trigger, including the bootstrap from existing subscriptions. */
export function eventDemandSqliteStatements(): string[] {
  return [
    ...EVENT_DEMAND_REFRESH_STATEMENTS.map((statement) => `${statement};`),
    ...eventDemandSqliteTriggers().map((trigger) => trigger.sql),
  ];
}

const SQLITE_DEMAND_TRIGGER = /^CREATE TRIGGER (demand_\w+) AFTER ([\s\S]+?) ON (\w+)\nWHEN ([\s\S]+?)\nBEGIN\n {2}([\s\S]+?);\nEND;?$/;

/**
 * PostgreSQL serializes subscription changes, so concurrent subscribers
 * cannot erase each other's demand. Compiled from the SQLite trigger as
 * installed (`sqliteSql`, its sqlite_master text), so every schema version
 * compiles to the form its own migration wrote.
 */
export function eventDemandPostgresTrigger(name: string, sqliteSql: string): string | undefined {
  if (!name.startsWith("demand_")) return undefined;
  const match = SQLITE_DEMAND_TRIGGER.exec(sqliteSql.trim());
  if (!match || match[1] !== name) return undefined;
  const [, , event, table, sqliteGuard, statement] = match;
  const guard = sqliteGuard!.replaceAll(" IS NOT ", " IS DISTINCT FROM ");
  return `CREATE OR REPLACE FUNCTION scalius_compat."${name}_fn"()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $trigger_function$\nBEGIN\n  LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE;\n  ${statement};\n  RETURN NULL;\nEND\n$trigger_function$;\nCREATE TRIGGER "${name}" AFTER ${event} ON ${table}\nFOR EACH ROW WHEN (${guard}) EXECUTE FUNCTION scalius_compat."${name}_fn"();`;
}
