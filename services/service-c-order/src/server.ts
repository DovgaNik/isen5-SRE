//potential trap: loading Express before initialization can prevent automatic instrumentation from attaching. Initialize the SDK first
import './instrumentation';
import { metrics } from '@opentelemetry/api';
import { prometheusExporter } from './instrumentation';

import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';
import { log } from './logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';
const tracer = trace.getTracer(SERVICE_NAME);
const meter = metrics.getMeter(SERVICE_NAME);

const httpRequests = meter.createCounter('http_requests', {
  description: 'Number of completed HTTP requests',
});

const httpDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'Duration of completed HTTP requests',
  unit: 's',
});

function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
) {
  const spanContext = trace.getActiveSpan()?.spanContext();

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    event,
    trace_id: spanContext?.traceId ?? null,
    span_id: spanContext?.spanId ?? null,
    ...fields,
  }));
}

// Downstream service configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

app.use((req, res, next) => {
  // Exclude scrapes so monitoring traffic does not affect RED metrics.
  if (req.path === '/metrics') {
    next();
    return;
  }

  const started = process.hrtime.bigint();
  // potential trap: reading the active span only inside "finish" may lose request correlation. Following the course, capture its IDs while the request context is active.
  const requestSpanContext = trace.getActiveSpan()?.spanContext();

  res.once('finish', () => {
    const route =
      typeof req.route?.path === 'string'
        ? req.route.path
        : 'unmatched';

    const method = [
      'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
      'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
    ].includes(req.method)
      ? req.method
      : 'OTHER';

    const labels = {
      method,
      route,
      status: String(res.statusCode),
    };

    const durationSeconds =
      Number(process.hrtime.bigint() - started) / 1e9;

    // Never add user IDs, order IDs, tokens or raw URLs as metric labels.
    httpRequests.add(1, labels);
    httpDuration.record(durationSeconds, labels);
      logEvent(
      res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : 'info',
      'http.request.completed',
      {
        method,
        route,
        status: res.statusCode,
        duration_seconds: durationSeconds,
        trace_id: requestSpanContext?.traceId ?? null,
        span_id: requestSpanContext?.spanId ?? null,
        user_id: res.locals.user_id,
        order_id: res.locals.order_id,
        reservation_id: res.locals.reservation_id,
        transaction_id: res.locals.transaction_id,
      },
    );
  });

  next();
});
app.use(cors());
app.use(express.json());

// ─── Prometheus RED Metrics ────────────────────────────────────────
client.collectDefaultMetrics({ labels: { service: SERVICE_NAME } });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/metrics') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });
  next();
});

// ─── Operational Health Probe ──────────────────────────────────────
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    downstreams: {
      auth: AUTH_SERVICE_URL,
      catalog: CATALOG_SERVICE_URL,
      payment: PAYMENT_SERVICE_URL,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics
 * Unauthenticated Prometheus exposition endpoint for OpenTelemetry metrics.
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ─── Helper for Outbound Trace Headers ─────────────────────────────
function getOutboundHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  // Inject active span context into outbound W3C traceparent / baggage headers
  propagation.inject(context.active(), headers);
  return headers;
}

// ─── Business Endpoints ────────────────────────────────────────────

/**
 * POST /orders/checkout
 * Coordinates distributed checkout transaction saga.
 */
app.post(
  '/orders/checkout',
  async (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    //potential trap: manually adding CLIENT spans around fetch would duplicate Undici instrumentation. but active context links its automatic CLIENT spans to this business operation
    return tracer.startActiveSpan('checkout', async (span) => {
      try {
    const fail = (status: number, message: string) => {
      span.setAttribute('checkout.outcome', 'failed');
      span.setAttribute('checkout.response_status', status);
      span.addEvent('checkout.failure', { reason: message });

      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }

      res.status(status).json({
        error: 'Checkout failed',
        message,
        status_code: status,
      });
    };
    const { user_id, items, payment_method } = req.body ?? {};
    if (typeof user_id !== 'string' || !user_id.trim() || typeof payment_method !== 'string' || !payment_method.trim()
      || !Array.isArray(items) || items.length === 0 || items.some((item) => !item
        || typeof item.product_id !== 'string' || !item.product_id.trim()
        || !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
      fail(400, 'user_id, payment_method, and valid items are required');
      return;
    }
    const authorization = req.header('authorization');
    if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) {
      fail(401, 'Bearer token is required');
      return;
    }

// potential trap: copying the same traceparent to every call reused its parent ID? BUT outgoing calls need child spans. Undici instrumentation creates those spans and injects their context.
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};
    const orderId = `ORD-${randomUUID()}`;
    // potential trap: dynamic IDs could become metric labels. we put these IDs in span attributes instead.
span.setAttribute('order.id', orderId);
res.locals.order_id = orderId;
    let reservationId: string | undefined;
    let paymentStarted = false;
    const releaseInventory = async () => {
      try {
        const { user_id, items, payment_method } = req.body ?? {};
        if (
          typeof user_id !== 'string' ||
          !user_id.trim() ||
          typeof payment_method !== 'string' ||
          !payment_method.trim() ||
          !Array.isArray(items) ||
          items.length === 0 ||
          items.some(
            (item) =>
              !item ||
              typeof item.product_id !== 'string' ||
              !item.product_id.trim() ||
              !Number.isSafeInteger(item.quantity) ||
              item.quantity <= 0
          )
        ) {
          fail(400, 'user_id, payment_method, and valid items are required');
          return;
        }

        const authorization = req.header('authorization');

        const orderId = `ORD-${randomUUID()}`;
        span.setAttribute('order.id', orderId);
        span.setAttribute('order.user_id', user_id);
        span.setAttribute('order.item_count', items.length);

        let reservationId: string | undefined;
        let paymentStarted = false;

        const releaseInventory = async () => {
          return await tracer.startActiveSpan('order.release_inventory', async (releaseSpan) => {
            try {
              releaseSpan.setAttribute('order.reservation_id', reservationId ?? '');
              const response = await fetch(`${CATALOG_SERVICE_URL}/inventory/release`, {
                method: 'POST',
                headers: getOutboundHeaders(),
                body: JSON.stringify({ reservation_id: reservationId }),
                signal: AbortSignal.timeout(3000),
              });
              const ok = response.ok;
              releaseSpan.setAttribute('release.success', ok);
              return ok;
            } catch (err: unknown) {
              releaseSpan.recordException(err as Error);
              releaseSpan.setAttribute('release.success', false);
              return false;
            } finally {
              releaseSpan.end();
            }
          });
        };

        // Step 1: Verify Auth
        const authOk = await tracer.startActiveSpan('order.verify_auth', async (authSpan) => {
          try {
            if (authorization && /^Bearer [^\s]+$/i.test(authorization)) {
              const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/verify`, {
                headers: getOutboundHeaders({ Authorization: authorization }),
                signal: AbortSignal.timeout(3000),
              });
              if (!authResponse.ok) {
                authSpan.setAttribute('auth.valid', false);
                fail(authResponse.status === 401 ? 401 : 502, 'Authentication failed');
                return false;
              }
              const auth = await authResponse.json();
              if (auth.valid !== true || typeof auth.user_id !== 'string') {
                fail(502, 'Invalid authentication response');
                return false;
              }
              if (auth.user_id !== user_id) {
                fail(403, 'user_id does not match the authenticated user');
                return false;
              }
              authSpan.setAttribute('auth.valid', true);
              authSpan.setAttribute('user.id', auth.user_id);
              return true;
            } else {
              // Synthetic / guest traffic (e.g. Load Generator scenarios)
              authSpan.setAttribute('auth.valid', true);
              authSpan.setAttribute('auth.mode', 'synthetic_guest');
              authSpan.setAttribute('user.id', user_id);
              return true;
            }
          } catch (err: unknown) {
            authSpan.recordException(err as Error);
            fail(503, 'Auth service unavailable');
            return false;
          } finally {
            authSpan.end();
          }
        });
        return response.ok;
      } catch (error) {
        logEvent('error', 'inventory.release.exception', {
          route: '/orders/checkout',
          order_id: orderId,
          reservation_id: reservationId,
          error_type: error instanceof Error ? error.name : 'UnknownError',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        });
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.addEvent('inventory.release.failed');
        return false;
      }
    };

    try {
      const authResponse = await fetch(`${AUTH_SERVICE_URL}/auth/verify`, {
        headers: { ...headers, Authorization: authorization }, signal: AbortSignal.timeout(3000),
      });
      if (!authResponse.ok) {
        fail(authResponse.status === 401 ? 401 : 502, 'Authentication failed');
        return;
      }
      const auth = await authResponse.json();
      if (auth.valid !== true || typeof auth.user_id !== 'string') { fail(502, 'Invalid authentication response'); return; }
      if (auth.user_id !== user_id) { fail(403, 'user_id does not match the authenticated user'); return; }
      //potential trap: a manually assigned baggage header is not active OpenTelemetry context. wekeep this identifier as an attribute on the current span.
      trace.getActiveSpan()?.setAttribute('user.id', auth.user_id);
      res.locals.user_id = auth.user_id;

      // Payment needs amount_cents; the existing reservation response contains no prices.
      const productsResponse = await fetch(`${CATALOG_SERVICE_URL}/products`, { headers, signal: AbortSignal.timeout(3000) });
      if (!productsResponse.ok) { fail(502, 'Catalog service failed to return products'); return; }
      const products = await productsResponse.json();
      if (!Array.isArray(products)) { fail(502, 'Invalid catalog response'); return; }
      let totalCents = 0;
      for (const item of items) {
        const product = products.find((product) => product && product.id === item.product_id);
        if (!product) { fail(400, `Unknown product: ${item.product_id}`); return; }
        if (!Number.isSafeInteger(product.price_cents) || product.price_cents < 0) { fail(502, 'Invalid product price'); return; }
        totalCents += product.price_cents * item.quantity;
      }
      if (!Number.isSafeInteger(totalCents)) { fail(400, 'Checkout total is too large'); return; }

      const reservationResponse = await fetch(`${CATALOG_SERVICE_URL}/inventory/reserve`, {
        method: 'POST', headers, body: JSON.stringify({ items }), signal: AbortSignal.timeout(3000),
      });
      if (!reservationResponse.ok) { fail(reservationResponse.status === 409 ? 409 : 502, 'Inventory reservation failed'); return; }
      const reservation = await reservationResponse.json();
      if (reservation.status !== 'reserved' || typeof reservation.reservation_id !== 'string' || !reservation.reservation_id) {
        fail(502, 'Invalid reservation response'); return;
      }
      reservationId = reservation.reservation_id;
      res.locals.reservation_id = reservationId;
      if (reservationId !== undefined) {
        span.setAttribute('reservation.id', reservationId);
      }
      span.setAttribute('order.total_cents', totalCents);

      paymentStarted = true;
      const paymentResponse = await fetch(`${PAYMENT_SERVICE_URL}/payments/charge`, {
        method: 'POST', headers,
        body: JSON.stringify({ order_id: orderId, amount_cents: totalCents, idempotency_key: orderId }),
        signal: AbortSignal.timeout(3000),
      });
      const payment = await paymentResponse.json().catch(() => null);
      const declined = (paymentResponse.status >= 400 && paymentResponse.status < 500)
        || (paymentResponse.ok && ['FAILED_DECLINED', 'FAILED_INSUFFICIENT_FUNDS'].includes(payment?.status));
      if (declined) {
        span.addEvent('payment.declined');
        span.addEvent('inventory.release.requested');
        if (!await releaseInventory()) { fail(502, 'Payment failed and inventory release failed'); return; }
        res.status(402).json({ order_id: orderId, status: 'FAILED', message: 'Payment declined; inventory released' });
        return;
      }
      if (!paymentResponse.ok || payment?.status !== 'SUCCESS' || typeof payment.transaction_id !== 'string' || !payment.transaction_id) {
        fail(502, `Payment outcome unknown; reservation ${reservationId} retained`); return;
      }
      span.setAttribute('checkout.outcome', 'confirmed');
      span.setAttribute('payment.transaction_id', payment.transaction_id);
      res.locals.transaction_id = payment.transaction_id;
      res.status(201).json({
        order_id: orderId, status: 'CONFIRMED', total_cents: totalCents,
        reservation_id: reservationId, transaction_id: payment.transaction_id,
      });
    } catch (error) {
      //potential trap: returning an HTTP error alone lost diagnostic details. we record the exception.
      logEvent('error', 'checkout.exception', {
        route: '/orders/checkout',
        order_id: orderId,
        reservation_id: reservationId,
        error_type: error instanceof Error ? error.name : 'UnknownError',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });

      if (reservationId && !paymentStarted && !await releaseInventory()) {
        fail(502, 'Checkout failed and inventory release failed');
        return;
      }

      // A lost payment response does not prove the charge failed
      fail(
        503,
        paymentStarted
          ? `Payment outcome unknown; reservation ${reservationId} retained`
          : 'A checkout dependency is unavailable',
      );
    }
      } finally {
        // potential trap: success and early error returns must both finish the business span.
        span.end();
      }
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  logEvent('info', 'service.started', {
    port: PORT,
    downstreams: {
      auth: AUTH_SERVICE_URL,
      catalog: CATALOG_SERVICE_URL,
      payment: PAYMENT_SERVICE_URL,
    },
  });
});
