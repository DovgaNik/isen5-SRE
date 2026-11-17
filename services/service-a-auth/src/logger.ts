import { trace, context } from '@opentelemetry/api';

const SERVICE_NAME = 'service-a-auth';
const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...(spanContext?.traceId ? { trace_id: spanContext.traceId } : {}),
    ...(spanContext?.spanId ? { span_id: spanContext.spanId } : {}),
    ...extra,
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // Asynchronously forward to Loki
  const nanoTime = `${Date.now()}000000`;
  fetch(`${LOKI_URL}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streams: [
        {
          stream: {
            service: SERVICE_NAME,
            level,
          },
          values: [[nanoTime, line]],
        },
      ],
    }),
  }).catch(() => {});
}
