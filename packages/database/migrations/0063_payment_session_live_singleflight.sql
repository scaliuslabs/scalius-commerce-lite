WITH ranked_live_payment_sessions AS (
  SELECT
    `id`,
    row_number() OVER (
      PARTITION BY `order_id`, `gateway`, `payment_type`
      ORDER BY coalesce(`claim_expires_at`, 0) DESC, `updated_at` DESC, `created_at` DESC
    ) AS `rank`
  FROM `payment_session_attempts`
  WHERE `status` = 'processing'
)
UPDATE `payment_session_attempts`
SET
  `status` = 'failed',
  `claim_id` = NULL,
  `claim_expires_at` = NULL,
  `last_error` = 'Superseded by live payment session single-flight migration.',
  `updated_at` = unixepoch()
WHERE `id` IN (
  SELECT `id`
  FROM ranked_live_payment_sessions
  WHERE `rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_session_attempts_live_order_singleflight`
ON `payment_session_attempts` (`order_id`, `gateway`, `payment_type`)
WHERE `status` = 'processing';
