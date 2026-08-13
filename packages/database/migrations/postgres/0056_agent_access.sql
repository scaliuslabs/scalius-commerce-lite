CREATE TABLE "agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text,
	"resource" text NOT NULL,
	"label" text NOT NULL,
	"oauth_client_id" text,
	"oauth_client_name" text,
	"oauth_redirect_uris_json" text,
	"preset" text NOT NULL,
	"permissions_json" text DEFAULT '[]' NOT NULL,
	"risk_ceiling" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"authority_revision" bigint DEFAULT 1 NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint,
	"last_operation_id" text,
	"revoked_by_user_id" text,
	"revoked_reason" text,
	"revoked_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("revoked_by_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_grants_id_shape" CHECK(length("agent_grants"."id") = 24 AND substr("agent_grants"."id", 1, 4) = 'agr_'),
	CONSTRAINT "agent_grants_kind" CHECK("agent_grants"."kind" IN ('oauth', 'pat', 'cli')),
	CONSTRAINT "agent_grants_resource" CHECK("agent_grants"."resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_grants_label" CHECK(length(trim("agent_grants"."label")) BETWEEN 1 AND 120),
	CONSTRAINT "agent_grants_preset" CHECK("agent_grants"."preset" IN ('read', 'operator', 'full', 'custom')),
	CONSTRAINT "agent_grants_permissions_json" CHECK(jsonb_typeof("agent_grants"."permissions_json"::jsonb) = 'array' AND length("agent_grants"."permissions_json") BETWEEN 2 AND 65536),
	CONSTRAINT "agent_grants_risk_ceiling" CHECK("agent_grants"."risk_ceiling" IN ('read', 'write', 'destructive', 'financial', 'security')),
	CONSTRAINT "agent_grants_status" CHECK("agent_grants"."status" IN ('pending', 'active', 'revoked')),
	CONSTRAINT "agent_grants_authority_revision" CHECK("agent_grants"."authority_revision" > 0),
	CONSTRAINT "agent_grants_expiry" CHECK("agent_grants"."expires_at" > "agent_grants"."created_at"),
	CONSTRAINT "agent_grants_oauth_metadata" CHECK((
            "agent_grants"."kind" = 'oauth'
            AND "agent_grants"."oauth_client_id" IS NOT NULL
            AND "agent_grants"."oauth_redirect_uris_json" IS NOT NULL
            AND jsonb_typeof("agent_grants"."oauth_redirect_uris_json"::jsonb) = 'array'
        ) OR (
            "agent_grants"."kind" IN ('pat', 'cli')
            AND "agent_grants"."oauth_client_id" IS NULL
            AND "agent_grants"."oauth_client_name" IS NULL
            AND "agent_grants"."oauth_redirect_uris_json" IS NULL
        )),
	CONSTRAINT "agent_grants_revocation_state" CHECK((
            "agent_grants"."status" = 'revoked' AND "agent_grants"."revoked_at" IS NOT NULL
        ) OR (
            "agent_grants"."status" <> 'revoked'
            AND "agent_grants"."revoked_at" IS NULL
            AND "agent_grants"."revoked_by_user_id" IS NULL
            AND "agent_grants"."revoked_reason" IS NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	"rotated_at" bigint,
	"rotated_from_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("rotated_from_id") REFERENCES "agent_credentials"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_credentials_id_shape" CHECK(length("agent_credentials"."id") = 24 AND substr("agent_credentials"."id", 1, 4) = 'agc_'),
	CONSTRAINT "agent_credentials_kind" CHECK("agent_credentials"."kind" IN ('pat', 'cli')),
	CONSTRAINT "agent_credentials_token_hash" CHECK(length("agent_credentials"."token_hash") = 64),
	CONSTRAINT "agent_credentials_token_hint" CHECK(length("agent_credentials"."token_hint") BETWEEN 12 AND 120),
	CONSTRAINT "agent_credentials_expiry" CHECK("agent_credentials"."expires_at" > "agent_credentials"."created_at"),
	CONSTRAINT "agent_credentials_rotation_state" CHECK("agent_credentials"."rotated_at" IS NULL OR "agent_credentials"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "agent_authorization_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"encrypted_request" text,
	"resource" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"redirect_uri" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_by_user_id" text,
	"decided_at" bigint,
	"grant_id" text,
	"completion_claim_hash" text,
	"completion_claim_expires_at" bigint,
	"completed_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_authorization_requests_id_shape" CHECK(length("agent_authorization_requests"."id") = 24 AND substr("agent_authorization_requests"."id", 1, 4) = 'aar_'),
	CONSTRAINT "agent_authorization_requests_resource" CHECK("agent_authorization_requests"."resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_authorization_requests_status" CHECK("agent_authorization_requests"."status" IN ('pending', 'approved', 'completing', 'completed', 'denying', 'denied', 'expired')),
	CONSTRAINT "agent_authorization_requests_expiry" CHECK("agent_authorization_requests"."expires_at" > "agent_authorization_requests"."created_at"),
	CONSTRAINT "agent_authorization_requests_decision" CHECK((
            "agent_authorization_requests"."status" = 'pending'
            AND "agent_authorization_requests"."encrypted_request" IS NOT NULL
            AND "agent_authorization_requests"."decided_at" IS NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NULL
            AND "agent_authorization_requests"."grant_id" IS NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NULL
        ) OR (
            "agent_authorization_requests"."status" = 'approved'
            AND "agent_authorization_requests"."encrypted_request" IS NOT NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NOT NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NULL
        ) OR (
            "agent_authorization_requests"."status" = 'completing'
            AND "agent_authorization_requests"."encrypted_request" IS NOT NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NOT NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NOT NULL
            AND length("agent_authorization_requests"."completion_claim_hash") = 64
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NOT NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" > "agent_authorization_requests"."updated_at"
            AND "agent_authorization_requests"."completed_at" IS NULL
        ) OR (
            "agent_authorization_requests"."status" = 'completed'
            AND "agent_authorization_requests"."encrypted_request" IS NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NOT NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NOT NULL
            AND "agent_authorization_requests"."completed_at" >= "agent_authorization_requests"."decided_at"
        ) OR (
            "agent_authorization_requests"."status" = 'denying'
            AND "agent_authorization_requests"."encrypted_request" IS NOT NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NULL
            AND (
                (
                    "agent_authorization_requests"."completion_claim_hash" IS NULL
                    AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
                ) OR (
                    "agent_authorization_requests"."completion_claim_hash" IS NOT NULL
                    AND length("agent_authorization_requests"."completion_claim_hash") = 64
                    AND "agent_authorization_requests"."completion_claim_expires_at" IS NOT NULL
                    AND "agent_authorization_requests"."completion_claim_expires_at" > "agent_authorization_requests"."updated_at"
                )
            )
        ) OR (
            "agent_authorization_requests"."status" = 'denied'
            AND "agent_authorization_requests"."encrypted_request" IS NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."decided_by_user_id" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NOT NULL
            AND "agent_authorization_requests"."completed_at" >= "agent_authorization_requests"."decided_at"
        ) OR (
            "agent_authorization_requests"."status" = 'expired'
            AND "agent_authorization_requests"."encrypted_request" IS NULL
            AND "agent_authorization_requests"."decided_at" IS NOT NULL
            AND "agent_authorization_requests"."grant_id" IS NULL
            AND "agent_authorization_requests"."completion_claim_hash" IS NULL
            AND "agent_authorization_requests"."completion_claim_expires_at" IS NULL
            AND "agent_authorization_requests"."completed_at" IS NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "agent_device_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hmac" text NOT NULL,
	"requested_resource" text NOT NULL,
	"requested_preset" text NOT NULL,
	"client_name" text,
	"profile_name" text,
	"requested_permissions_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"poll_interval_seconds" bigint DEFAULT 5 NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_polled_at" bigint,
	"approved_by_user_id" text,
	"decided_at" bigint,
	"grant_id" text,
	"credential_id" text,
	"encrypted_delivery_envelope" text,
	"acknowledged_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("credential_id") REFERENCES "agent_credentials"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_device_authorizations_id_shape" CHECK(length("agent_device_authorizations"."id") = 24 AND substr("agent_device_authorizations"."id", 1, 4) = 'ada_'),
	CONSTRAINT "agent_device_authorizations_device_hash" CHECK(length("agent_device_authorizations"."device_code_hash") = 64),
	CONSTRAINT "agent_device_authorizations_user_hmac" CHECK(length("agent_device_authorizations"."user_code_hmac") = 64),
	CONSTRAINT "agent_device_authorizations_resource" CHECK("agent_device_authorizations"."requested_resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_device_authorizations_preset" CHECK("agent_device_authorizations"."requested_preset" IN ('read', 'operator', 'full', 'custom')),
	CONSTRAINT "agent_device_authorizations_client_name" CHECK("agent_device_authorizations"."client_name" IS NULL OR length(trim("agent_device_authorizations"."client_name")) BETWEEN 1 AND 80),
	CONSTRAINT "agent_device_authorizations_profile_name" CHECK("agent_device_authorizations"."profile_name" IS NULL OR length(trim("agent_device_authorizations"."profile_name")) BETWEEN 1 AND 80),
	CONSTRAINT "agent_device_authorizations_permissions_json" CHECK(jsonb_typeof("agent_device_authorizations"."requested_permissions_json"::jsonb) = 'array' AND length("agent_device_authorizations"."requested_permissions_json") BETWEEN 2 AND 65536),
	CONSTRAINT "agent_device_authorizations_status" CHECK("agent_device_authorizations"."status" IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
	CONSTRAINT "agent_device_authorizations_poll_interval" CHECK("agent_device_authorizations"."poll_interval_seconds" BETWEEN 1 AND 60),
	CONSTRAINT "agent_device_authorizations_expiry" CHECK("agent_device_authorizations"."expires_at" > "agent_device_authorizations"."created_at"),
	CONSTRAINT "agent_device_authorizations_state" CHECK((
            "agent_device_authorizations"."status" = 'pending'
            AND "agent_device_authorizations"."decided_at" IS NULL
            AND "agent_device_authorizations"."grant_id" IS NULL
            AND "agent_device_authorizations"."credential_id" IS NULL
            AND "agent_device_authorizations"."encrypted_delivery_envelope" IS NULL
            AND "agent_device_authorizations"."acknowledged_at" IS NULL
        ) OR (
            "agent_device_authorizations"."status" = 'approved'
            AND "agent_device_authorizations"."decided_at" IS NOT NULL
            AND "agent_device_authorizations"."approved_by_user_id" IS NOT NULL
            AND "agent_device_authorizations"."grant_id" IS NOT NULL
            AND "agent_device_authorizations"."credential_id" IS NOT NULL
            AND "agent_device_authorizations"."encrypted_delivery_envelope" IS NOT NULL
            AND "agent_device_authorizations"."acknowledged_at" IS NULL
        ) OR (
            "agent_device_authorizations"."status" = 'consumed'
            AND "agent_device_authorizations"."decided_at" IS NOT NULL
            AND "agent_device_authorizations"."approved_by_user_id" IS NOT NULL
            AND "agent_device_authorizations"."grant_id" IS NOT NULL
            AND "agent_device_authorizations"."credential_id" IS NOT NULL
            AND "agent_device_authorizations"."encrypted_delivery_envelope" IS NULL
            AND "agent_device_authorizations"."acknowledged_at" IS NOT NULL
        ) OR (
            "agent_device_authorizations"."status" IN ('denied', 'expired')
            AND "agent_device_authorizations"."grant_id" IS NULL
            AND "agent_device_authorizations"."credential_id" IS NULL
            AND "agent_device_authorizations"."encrypted_delivery_envelope" IS NULL
            AND "agent_device_authorizations"."acknowledged_at" IS NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "agent_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text,
	"credential_id" text,
	"owner_user_id" text,
	"resource" text,
	"operation_id" text NOT NULL,
	"risk" text NOT NULL,
	"outcome" text NOT NULL,
	"http_status" bigint,
	"error_class" text,
	"duration_ms" bigint,
	"request_id" text,
	"idempotency_key_hash_prefix" text,
	"resource_ids_json" text DEFAULT '[]' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("credential_id") REFERENCES "agent_credentials"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_audit_events_id_shape" CHECK(length("agent_audit_events"."id") = 24 AND substr("agent_audit_events"."id", 1, 4) = 'aae_'),
	CONSTRAINT "agent_audit_events_resource" CHECK("agent_audit_events"."resource" IS NULL OR "agent_audit_events"."resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_audit_events_operation_id" CHECK(length("agent_audit_events"."operation_id") BETWEEN 1 AND 160),
	CONSTRAINT "agent_audit_events_risk" CHECK("agent_audit_events"."risk" IN ('read', 'write', 'destructive', 'financial', 'security')),
	CONSTRAINT "agent_audit_events_outcome" CHECK("agent_audit_events"."outcome" IN ('success', 'denied', 'failed')),
	CONSTRAINT "agent_audit_events_http_status" CHECK("agent_audit_events"."http_status" IS NULL OR "agent_audit_events"."http_status" BETWEEN 100 AND 599),
	CONSTRAINT "agent_audit_events_duration" CHECK("agent_audit_events"."duration_ms" IS NULL OR "agent_audit_events"."duration_ms" >= 0),
	CONSTRAINT "agent_audit_events_idempotency_prefix" CHECK("agent_audit_events"."idempotency_key_hash_prefix" IS NULL OR length("agent_audit_events"."idempotency_key_hash_prefix") BETWEEN 8 AND 24),
	CONSTRAINT "agent_audit_events_resource_ids_json" CHECK(jsonb_typeof("agent_audit_events"."resource_ids_json"::jsonb) = 'array' AND length("agent_audit_events"."resource_ids_json") BETWEEN 2 AND 4096),
	CONSTRAINT "agent_audit_events_metadata_json" CHECK(jsonb_typeof("agent_audit_events"."metadata_json"::jsonb) = 'object' AND length("agent_audit_events"."metadata_json") BETWEEN 2 AND 8192)
);
--> statement-breakpoint
CREATE TABLE "agent_storefront_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"cart_json" text DEFAULT '[]' NOT NULL,
	"discount_code" text,
	"city_id" text,
	"zone_id" text,
	"area_id" text,
	"shipping_method_id" text,
	"customer_session_token_hash" text,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint,
	"closed_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("customer_session_token_hash") REFERENCES "customer_sessions"("token_hash") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_storefront_contexts_id_shape" CHECK(length("agent_storefront_contexts"."id") = 24 AND substr("agent_storefront_contexts"."id", 1, 4) = 'asc_'),
	CONSTRAINT "agent_storefront_contexts_status" CHECK("agent_storefront_contexts"."status" IN ('active', 'closed', 'expired', 'revoked')),
	CONSTRAINT "agent_storefront_contexts_revision" CHECK("agent_storefront_contexts"."revision" >= 1),
	CONSTRAINT "agent_storefront_contexts_cart_json" CHECK(jsonb_typeof("agent_storefront_contexts"."cart_json"::jsonb) = 'array' AND jsonb_array_length("agent_storefront_contexts"."cart_json"::jsonb) BETWEEN 0 AND 99 AND length("agent_storefront_contexts"."cart_json") BETWEEN 2 AND 65536),
	CONSTRAINT "agent_storefront_contexts_expiry" CHECK("agent_storefront_contexts"."expires_at" > "agent_storefront_contexts"."created_at"),
	CONSTRAINT "agent_storefront_contexts_close_state" CHECK((
            "agent_storefront_contexts"."status" = 'active' AND "agent_storefront_contexts"."closed_at" IS NULL
        ) OR (
            "agent_storefront_contexts"."status" <> 'active' AND "agent_storefront_contexts"."closed_at" IS NOT NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "agent_storefront_continuations" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"kind" text NOT NULL,
	"order_id" text,
	"payment_attempt_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"bootstrap_code_hash" text,
	"bootstrap_claimed_at" bigint,
	"safe_result_json" text,
	"completed_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("context_id") REFERENCES "agent_storefront_contexts"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_session_attempts"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_storefront_continuations_id_shape" CHECK(length("agent_storefront_continuations"."id") = 24 AND substr("agent_storefront_continuations"."id", 1, 4) = 'acn_'),
	CONSTRAINT "agent_storefront_continuations_kind" CHECK("agent_storefront_continuations"."kind" IN ('customer_auth', 'payment', 'payment_recovery')),
	CONSTRAINT "agent_storefront_continuations_status" CHECK("agent_storefront_continuations"."status" IN ('pending', 'complete', 'expired', 'failed')),
	CONSTRAINT "agent_storefront_continuations_expiry" CHECK("agent_storefront_continuations"."expires_at" > "agent_storefront_continuations"."created_at"),
	CONSTRAINT "agent_storefront_continuations_bootstrap_hash" CHECK("agent_storefront_continuations"."bootstrap_code_hash" IS NULL OR "agent_storefront_continuations"."bootstrap_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_storefront_continuations_bootstrap_claim_time" CHECK("agent_storefront_continuations"."bootstrap_claimed_at" IS NULL OR (
            "agent_storefront_continuations"."bootstrap_claimed_at" >= "agent_storefront_continuations"."created_at"
            AND "agent_storefront_continuations"."bootstrap_claimed_at" <= "agent_storefront_continuations"."expires_at"
        )),
	CONSTRAINT "agent_storefront_continuations_bootstrap_state" CHECK((
            "agent_storefront_continuations"."status" = 'pending'
            AND (
                ("agent_storefront_continuations"."bootstrap_code_hash" IS NOT NULL AND "agent_storefront_continuations"."bootstrap_claimed_at" IS NULL)
                OR ("agent_storefront_continuations"."bootstrap_code_hash" IS NULL AND "agent_storefront_continuations"."bootstrap_claimed_at" IS NOT NULL)
            )
        ) OR (
            "agent_storefront_continuations"."status" <> 'pending'
            AND "agent_storefront_continuations"."bootstrap_code_hash" IS NULL
        )),
	CONSTRAINT "agent_storefront_continuations_result_json" CHECK("agent_storefront_continuations"."safe_result_json" IS NULL OR (jsonb_typeof("agent_storefront_continuations"."safe_result_json"::jsonb) = 'object' AND length("agent_storefront_continuations"."safe_result_json") BETWEEN 2 AND 8192)),
	CONSTRAINT "agent_storefront_continuations_completion_state" CHECK((
            "agent_storefront_continuations"."status" = 'pending'
            AND "agent_storefront_continuations"."completed_at" IS NULL
            AND "agent_storefront_continuations"."safe_result_json" IS NULL
        ) OR (
            "agent_storefront_continuations"."status" <> 'pending'
            AND "agent_storefront_continuations"."completed_at" IS NOT NULL
        ))
);
--> statement-breakpoint
CREATE TABLE "agent_storefront_order_grants" (
	"context_id" text NOT NULL,
	"order_id" text NOT NULL,
	"authority_kind" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	PRIMARY KEY("context_id", "order_id"),
	FOREIGN KEY ("context_id") REFERENCES "agent_storefront_contexts"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE no action ON DELETE cascade DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_storefront_order_grants_authority_kind" CHECK("agent_storefront_order_grants"."authority_kind" IN ('created', 'recovered', 'customer')),
	CONSTRAINT "agent_storefront_order_grants_expiry" CHECK("agent_storefront_order_grants"."expires_at" > "agent_storefront_order_grants"."created_at")
);
--> statement-breakpoint
CREATE INDEX "agent_audit_events_grant_created_idx" ON "agent_audit_events" ("grant_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_audit_events_credential_created_idx" ON "agent_audit_events" ("credential_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_audit_events_owner_created_idx" ON "agent_audit_events" ("owner_user_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_audit_events_operation_created_idx" ON "agent_audit_events" ("operation_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_audit_events_outcome_created_idx" ON "agent_audit_events" ("outcome","created_at");
--> statement-breakpoint
CREATE INDEX "agent_audit_events_created_idx" ON "agent_audit_events" ("created_at");
--> statement-breakpoint
CREATE INDEX "agent_authorization_requests_status_expiry_idx" ON "agent_authorization_requests" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_authorization_requests_client_created_idx" ON "agent_authorization_requests" ("client_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_authorization_requests_grant_idx" ON "agent_authorization_requests" ("grant_id");
--> statement-breakpoint
CREATE INDEX "agent_authorization_requests_completion_claim_idx" ON "agent_authorization_requests" ("status","completion_claim_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_uq" ON "agent_credentials" ("token_hash");
--> statement-breakpoint
CREATE INDEX "agent_credentials_grant_expiry_idx" ON "agent_credentials" ("grant_id","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_credentials_active_expiry_idx" ON "agent_credentials" ("revoked_at","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_credentials_rotated_from_idx" ON "agent_credentials" ("rotated_from_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_authorizations_device_code_uq" ON "agent_device_authorizations" ("device_code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_authorizations_user_code_uq" ON "agent_device_authorizations" ("user_code_hmac");
--> statement-breakpoint
CREATE INDEX "agent_device_authorizations_status_expiry_idx" ON "agent_device_authorizations" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_device_authorizations_grant_idx" ON "agent_device_authorizations" ("grant_id");
--> statement-breakpoint
CREATE INDEX "agent_device_authorizations_credential_idx" ON "agent_device_authorizations" ("credential_id");
--> statement-breakpoint
CREATE INDEX "agent_grants_owner_status_idx" ON "agent_grants" ("owner_user_id","status");
--> statement-breakpoint
CREATE INDEX "agent_grants_resource_status_expiry_idx" ON "agent_grants" ("resource","status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_grants_status_expiry_idx" ON "agent_grants" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_grants_last_used_idx" ON "agent_grants" ("last_used_at");
--> statement-breakpoint
CREATE INDEX "agent_storefront_contexts_grant_status_idx" ON "agent_storefront_contexts" ("grant_id","status");
--> statement-breakpoint
CREATE INDEX "agent_storefront_contexts_status_expiry_idx" ON "agent_storefront_contexts" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_storefront_contexts_customer_session_idx" ON "agent_storefront_contexts" ("customer_session_token_hash");
--> statement-breakpoint
CREATE INDEX "agent_storefront_contexts_last_used_idx" ON "agent_storefront_contexts" ("last_used_at");
--> statement-breakpoint
CREATE INDEX "agent_storefront_continuations_context_status_idx" ON "agent_storefront_continuations" ("context_id","status");
--> statement-breakpoint
CREATE INDEX "agent_storefront_continuations_status_expiry_idx" ON "agent_storefront_continuations" ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_storefront_continuations_order_idx" ON "agent_storefront_continuations" ("order_id");
--> statement-breakpoint
CREATE INDEX "agent_storefront_continuations_payment_attempt_idx" ON "agent_storefront_continuations" ("payment_attempt_id");
--> statement-breakpoint
CREATE INDEX "agent_storefront_order_grants_order_expiry_idx" ON "agent_storefront_order_grants" ("order_id","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_storefront_order_grants_expiry_idx" ON "agent_storefront_order_grants" ("expires_at");
--> statement-breakpoint
CREATE TABLE "agent_artifact_handles" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"credential_id" text,
	"resource" text NOT NULL,
	"operation_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"media_type" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" bigint NOT NULL,
	"claimed_at" bigint,
	"failure_class" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	FOREIGN KEY ("grant_id") REFERENCES "agent_grants"("id") ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY ("credential_id") REFERENCES "agent_credentials"("id") ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "agent_artifact_handles_id_shape" CHECK(length("agent_artifact_handles"."id") = 24 AND substr("agent_artifact_handles"."id", 1, 4) = 'aah_'),
	CONSTRAINT "agent_artifact_handles_resource" CHECK("agent_artifact_handles"."resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_artifact_handles_operation_id" CHECK(length(trim("agent_artifact_handles"."operation_id")) BETWEEN 1 AND 240),
	CONSTRAINT "agent_artifact_handles_r2_key" CHECK(length(trim("agent_artifact_handles"."r2_key")) BETWEEN 1 AND 240),
	CONSTRAINT "agent_artifact_handles_media_type" CHECK(length(trim("agent_artifact_handles"."media_type")) BETWEEN 1 AND 120 AND "agent_artifact_handles"."media_type" ~ '^[ -~]+$'),
	CONSTRAINT "agent_artifact_handles_filename" CHECK(length(trim("agent_artifact_handles"."filename")) BETWEEN 1 AND 160
            AND "agent_artifact_handles"."filename" ~ '^[ -~]+$'
            AND position('/' in "agent_artifact_handles"."filename") = 0
            AND position(chr(92) in "agent_artifact_handles"."filename") = 0),
	CONSTRAINT "agent_artifact_handles_size" CHECK("agent_artifact_handles"."size_bytes" BETWEEN 1 AND 16777216),
	CONSTRAINT "agent_artifact_handles_sha256" CHECK("agent_artifact_handles"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_artifact_handles_status" CHECK("agent_artifact_handles"."status" IN ('active', 'consumed', 'expired', 'failed')),
	CONSTRAINT "agent_artifact_handles_expiry" CHECK("agent_artifact_handles"."expires_at" > "agent_artifact_handles"."created_at" AND "agent_artifact_handles"."expires_at" <= "agent_artifact_handles"."created_at" + 300),
	CONSTRAINT "agent_artifact_handles_claim_time" CHECK("agent_artifact_handles"."claimed_at" IS NULL OR ("agent_artifact_handles"."claimed_at" >= "agent_artifact_handles"."created_at" AND "agent_artifact_handles"."claimed_at" <= "agent_artifact_handles"."expires_at")),
	CONSTRAINT "agent_artifact_handles_failure_class" CHECK("agent_artifact_handles"."failure_class" IS NULL OR "agent_artifact_handles"."failure_class" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "agent_artifact_handles_state" CHECK((
            "agent_artifact_handles"."status" IN ('active', 'expired')
            AND "agent_artifact_handles"."claimed_at" IS NULL
            AND "agent_artifact_handles"."failure_class" IS NULL
        ) OR (
            "agent_artifact_handles"."status" = 'consumed'
            AND "agent_artifact_handles"."claimed_at" IS NOT NULL
            AND "agent_artifact_handles"."failure_class" IS NULL
        ) OR (
            "agent_artifact_handles"."status" = 'failed'
            AND "agent_artifact_handles"."claimed_at" IS NOT NULL
            AND "agent_artifact_handles"."failure_class" IS NOT NULL
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_artifact_handles_r2_key_uq" ON "agent_artifact_handles" ("r2_key");
--> statement-breakpoint
CREATE INDEX "agent_artifact_handles_grant_status_expiry_idx" ON "agent_artifact_handles" ("grant_id","status","expires_at");
--> statement-breakpoint
CREATE INDEX "agent_artifact_handles_status_expiry_idx" ON "agent_artifact_handles" ("status","expires_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (56, '0056_agent_access', 'ca86ab76f26135b9e6ea259c40c474e6e83ef510ed7544ecb990a4fbc09d1af4');
