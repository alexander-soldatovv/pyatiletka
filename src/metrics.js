const DEFAULT_COUNTERS = [
  'api_requests',
  'http_errors',
  'updates_processed',
  'update_errors',
  'messages_sent',
  'reminders_sent',
  'reminder_errors',
];

export function safeErrorDetails(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code)
    ? error.code
    : undefined;
  return {
    error_name: error instanceof Error ? error.name : 'UnknownError',
    error_code: code,
    status: Number.isInteger(error?.status) ? error.status : undefined,
  };
}

export function createMetrics({ clock = () => new Date() } = {}) {
  const startedAt = clock().getTime();
  const counters = Object.fromEntries(DEFAULT_COUNTERS.map((name) => [name, 0]));

  return {
    increment(name, amount = 1) {
      if (!Number.isFinite(amount)) throw new TypeError('Значение счётчика должно быть числом');
      counters[name] = (counters[name] ?? 0) + amount;
    },

    snapshot() {
      return {
        uptime_seconds: Math.max(0, Math.floor((clock().getTime() - startedAt) / 1000)),
        counters: { ...counters },
      };
    },
  };
}
