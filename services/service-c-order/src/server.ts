import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import client from 'prom-client';
import { trace, context, propagation } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';
import { log } from './logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';
const tracer = trace.getTracer(SERVICE_NAME, '1.0');

// Downstream service configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

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

// ─── Metrics Exposition ────────────────────────────────────────────
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err: unknown) {
    res.status(500).end(err instanceof Error ? err.message : String(err));
  }
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
    await tracer.startActiveSpan('order.checkout', async (span) => {
      const fail = (status: number, message: string) => {
        span.setAttribute('order.status', 'FAILED');
        span.setAttribute('order.error', message);
        log('warn', 'Checkout failed', { error: message, status_code: status });
        res.status(status).json({ error: 'Checkout failed', message, status_code: status });
      };

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

        if (!authOk) return;

        // Step 2: Fetch Products to calculate total
        let totalCents = 0;
        const catalogOk = await tracer.startActiveSpan('order.fetch_catalog', async (catalogSpan) => {
          try {
            const productsResponse = await fetch(`${CATALOG_SERVICE_URL}/products`, {
              headers: getOutboundHeaders(),
              signal: AbortSignal.timeout(3000),
            });
            if (!productsResponse.ok) {
              fail(502, 'Catalog service failed to return products');
              return false;
            }
            const products = await productsResponse.json();
            if (!Array.isArray(products)) {
              fail(502, 'Invalid catalog response');
              return false;
            }
            for (const item of items) {
              const product = products.find(
                (p) => p && (p.id === item.product_id || p.id === item.product_id.replace(/^PROD-/, ''))
              );
              if (!product) {
                fail(400, `Unknown product: ${item.product_id}`);
                return false;
              }
              if (!Number.isSafeInteger(product.price_cents) || product.price_cents < 0) {
                fail(502, 'Invalid product price');
                return false;
              }
              totalCents += product.price_cents * item.quantity;
            }
            if (!Number.isSafeInteger(totalCents)) {
              fail(400, 'Checkout total is too large');
              return false;
            }
            catalogSpan.setAttribute('order.total_cents', totalCents);
            return true;
          } catch (err: unknown) {
            catalogSpan.recordException(err as Error);
            fail(503, 'Catalog service unavailable');
            return false;
          } finally {
            catalogSpan.end();
          }
        });

        if (!catalogOk) return;

        span.setAttribute('order.total_cents', totalCents);

        // Step 3: Reserve Inventory
        const reserveOk = await tracer.startActiveSpan('order.reserve_inventory', async (reserveSpan) => {
          try {
            const reservationResponse = await fetch(`${CATALOG_SERVICE_URL}/inventory/reserve`, {
              method: 'POST',
              headers: getOutboundHeaders(),
              body: JSON.stringify({ items }),
              signal: AbortSignal.timeout(3000),
            });
            if (!reservationResponse.ok) {
              fail(reservationResponse.status === 409 ? 409 : 502, 'Inventory reservation failed');
              return false;
            }
            const reservation = await reservationResponse.json();
            if (
              reservation.status !== 'reserved' ||
              typeof reservation.reservation_id !== 'string' ||
              !reservation.reservation_id
            ) {
              fail(502, 'Invalid reservation response');
              return false;
            }
            reservationId = reservation.reservation_id;
            if (reservationId) {
              reserveSpan.setAttribute('reservation.id', reservationId);
            }
            return true;
          } catch (err: unknown) {
            reserveSpan.recordException(err as Error);
            fail(503, 'Catalog service unavailable for reservation');
            return false;
          } finally {
            reserveSpan.end();
          }
        });

        if (!reserveOk) return;

        // Step 4: Charge Payment
        paymentStarted = true;
        await tracer.startActiveSpan('order.charge_payment', async (paymentSpan) => {
          try {
            paymentSpan.setAttribute('payment.amount_cents', totalCents);
            paymentSpan.setAttribute('payment.idempotency_key', orderId);

            const paymentResponse = await fetch(`${PAYMENT_SERVICE_URL}/payments/charge`, {
              method: 'POST',
              headers: getOutboundHeaders(),
              body: JSON.stringify({ order_id: orderId, amount_cents: totalCents, idempotency_key: orderId }),
              signal: AbortSignal.timeout(3000),
            });

            const payment = await paymentResponse.json().catch(() => null);
            const declined =
              (paymentResponse.status >= 400 && paymentResponse.status < 500) ||
              (paymentResponse.ok && ['FAILED_DECLINED', 'FAILED_INSUFFICIENT_FUNDS'].includes(payment?.status));

            if (declined) {
              paymentSpan.setAttribute('payment.declined', true);
              if (!(await releaseInventory())) {
                fail(502, 'Payment failed and inventory release failed');
                return;
              }
              span.setAttribute('order.status', 'DECLINED');
              log('warn', 'Order payment declined, inventory released', { order_id: orderId });
              res.status(402).json({
                order_id: orderId,
                status: 'FAILED',
                message: 'Payment declined; inventory released',
              });
              return;
            }

            if (
              !paymentResponse.ok ||
              payment?.status !== 'SUCCESS' ||
              typeof payment.transaction_id !== 'string' ||
              !payment.transaction_id
            ) {
              paymentSpan.setAttribute('payment.unknown', true);
              fail(502, `Payment outcome unknown; reservation ${reservationId} retained`);
              return;
            }

            paymentSpan.setAttribute('payment.transaction_id', payment.transaction_id);
            span.setAttribute('order.status', 'CONFIRMED');
            span.setAttribute('order.transaction_id', payment.transaction_id);
            if (reservationId) {
              span.setAttribute('order.reservation_id', reservationId);
            }

            log('info', 'Order checkout confirmed', {
              order_id: orderId,
              user_id,
              total_cents: totalCents,
              transaction_id: payment.transaction_id,
              reservation_id: reservationId,
            });

            res.status(201).json({
              order_id: orderId,
              status: 'CONFIRMED',
              total_cents: totalCents,
              reservation_id: reservationId,
              transaction_id: payment.transaction_id,
            });
          } catch (err: unknown) {
            paymentSpan.recordException(err as Error);
            if (reservationId && !paymentStarted && !(await releaseInventory())) {
              fail(502, 'Checkout failed and inventory release failed');
              return;
            }
            fail(503, paymentStarted ? `Payment outcome unknown; reservation ${reservationId} retained` : 'A checkout dependency is unavailable');
          } finally {
            paymentSpan.end();
          }
        });
      } catch (err: unknown) {
        span.recordException(err as Error);
        log('error', 'Unexpected error during checkout', { error: String(err) });
        res.status(500).json({ error: 'Internal Server Error', message: 'Checkout failure', status_code: 500 });
      } finally {
        span.end();
      }
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  log('info', `Listening on port ${PORT}`);
  log('info', `Downstream targets: Auth=${AUTH_SERVICE_URL}, Catalog=${CATALOG_SERVICE_URL}, Payment=${PAYMENT_SERVICE_URL}`);
});
