import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { AggregationType } from '@opentelemetry/sdk-metrics';
import { log } from './logger';

export const prometheusExporter = new PrometheusExporter({
  preventServerStart: true,
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'service-b-catalog',
    'service.version': '1.0.0',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317',
  }),
  metricReaders: [prometheusExporter],
  views: [{
    instrumentName: 'http_request_duration_seconds',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: {
        boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      },
    },
  }],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) =>
        ['/healthz', '/metrics'].includes(req.url?.split('?')[0] ?? ''),
    }),
    new ExpressInstrumentation(),
  ],
});

sdk.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    sdk.shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log('error', 'telemetry.shutdown.failed', {
          error_message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  });
}
