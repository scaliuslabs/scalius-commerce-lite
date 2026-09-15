CREATE TABLE "admin_identity_handoff_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"jti_hash" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text,
	"email" text NOT NULL,
	"user_id" text,
	"role" text,
	"outcome" text NOT NULL,
	"client_ip" text,
	"user_agent" text,
	"token_expires_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "admin_identity_handoff_events_kind_check" CHECK("admin_identity_handoff_events"."kind" IN ('handoff', 'revoke')),
	CONSTRAINT "admin_identity_handoff_events_jti_hash_check" CHECK(length("admin_identity_handoff_events"."jti_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_identity_handoff_events_jti_uidx" ON "admin_identity_handoff_events" ("jti_hash");
--> statement-breakpoint
CREATE INDEX "admin_identity_handoff_events_user_created_idx" ON "admin_identity_handoff_events" ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "admin_identity_handoff_events_expires_idx" ON "admin_identity_handoff_events" ("token_expires_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (62, '0062_identity_handoff_audit', 'c514c87ba34755f276246babc6d94a012a39a9e839919c5114539d41378c4cf7');
