interface Env {
  OPS_MONITOR_STATE: KVNamespace;

  READYZ_URL: string;
  READYZ_TIMEOUT_MS: string;
  QUEUE_METRICS_TIMEOUT_MS: string;
  DLQ_BACKLOG_THRESHOLD: string;
  QUEUE_OLDEST_AGE_THRESHOLD_MS: string;
  ALERT_STREAK_THRESHOLD: string;
  ALERT_COOLDOWN_MS: string;
  STATE_TTL_SECONDS: string;
  ALERT_EMAIL?: SendEmail;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_SUBJECT_PREFIX?: string;

  PAYMENT_EVENTS_QUEUE: Queue<unknown>;
  PAYMENT_EVENTS_DLQ: Queue<unknown>;
  ORDER_NOTIFICATIONS_QUEUE: Queue<unknown>;
  ORDER_NOTIFICATIONS_DLQ: Queue<unknown>;
  AUTH_OTP_QUEUE: Queue<unknown>;
  AUTH_OTP_DLQ: Queue<unknown>;
}
