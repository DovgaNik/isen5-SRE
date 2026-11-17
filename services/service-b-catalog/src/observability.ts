import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { log } from './logger';

const meter = metrics.getMeter('service-b-catalog');
const httpRequests = meter.createCounter('http_requests', {
  description: 'Number of completed or aborted HTTP requests',
});
const httpDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'Duration until HTTP request completion or client disconnect',
  unit: 's',
});

export const requestTelemetry: RequestHandler = (req, res, next) => {
  if (req.path === '/metrics' || req.path === '/healthz') {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  const spanContext = trace.getActiveSpan()?.spanContext();
  const complete = () => {
    res.removeListener('finish', complete);
    res.removeListener('close', complete);

    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    const method = [
      'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
    ].includes(req.method) ? req.method : 'OTHER';
    const aborted = !res.writableFinished;
    // 499 identifies client disconnects in telemetry; no response is sent with this code.
    const status = aborted ? 499 : res.statusCode;
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const labels = { method, route, status: String(status) };

    httpRequests.add(1, labels);
    httpDuration.record(durationSeconds, labels);
    log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      aborted ? 'http.request.aborted' : 'http.request.completed', {
        method,
        route,
        status,
        duration_seconds: durationSeconds,
        trace_id: spanContext?.traceId ?? null,
        span_id: spanContext?.spanId ?? null,
        reservation_id: res.locals.reservation_id,
      });
  };

  res.once('finish', complete);
  res.once('close', complete);
  next();
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  const exception = error instanceof Error ? error : new Error(String(error));
  const suppliedStatus = typeof error === 'object' && error !== null && 'status' in error
    ? error.status : undefined;
  const status = typeof suppliedStatus === 'number' && Number.isInteger(suppliedStatus)
    && suppliedStatus >= 400 && suppliedStatus < 600 ? suppliedStatus : 500;

  trace.getActiveSpan()?.recordException(exception);
  if (status >= 500) {
    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
  }
  log(status >= 500 ? 'error' : 'warn', 'http.request.exception', {
    error_type: exception.name,
    error_message: exception.message,
    status,
  });

  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(status).json({
    error: status >= 500 ? 'Internal Server Error' : 'Bad Request',
    message: status >= 500 ? 'The request could not be completed' : 'Invalid request body',
    status_code: status,
  });
};
