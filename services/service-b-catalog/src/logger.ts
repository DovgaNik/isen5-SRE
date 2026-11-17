import { trace } from '@opentelemetry/api';

const SERVICE_NAME = 'service-b-catalog';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, event: string, extra?: Record<string, unknown>): void {
  const spanContext = trace.getActiveSpan()?.spanContext();

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    event,
    trace_id: spanContext?.traceId ?? null,
    span_id: spanContext?.spanId ?? null,
    ...extra,
  });

  // Alloy collects container stdout/stderr and forwards each entry to Loki once.
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}
