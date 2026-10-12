import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID, randomBytes } from 'node:crypto';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';

// Downstream service configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

app.use(cors());
app.use(express.json());

// Operational health probe
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
 * Purpose: Prometheus exposition format endpoint.
 * Skeleton: Returns 501 Not Implemented.
 * TODO [Lab 2]: Install prom-client and implement RED metrics collection (http_requests_total, http_request_duration_seconds).
 */
app.get('/metrics', (_req: Request, res: Response<ErrorResponse>) => {
  res.status(501).json({
    error: 'Not Implemented',
    message: 'GET /metrics is not implemented in this skeleton. Implement Prometheus metrics in Lab 2.',
    status_code: 501,
  });
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * POST /orders/checkout
 * Purpose: Coordinates distributed checkout transaction saga.
 * Workflow to implement:
 *   1. Authenticate user via Service A (GET /auth/verify) with trace context.
 *   2. Reserve inventory via Service B (POST /inventory/reserve) with trace context.
 *   3. Charge customer via Service D (POST /payments/charge) with trace context.
 *   4. Return 201 Created with { "order_id": "ORD-...", "status": "CONFIRMED" }.
 */
app.post(
  '/orders/checkout',
  async (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    // 1. Validate incoming checkout payload (user_id, items, payment_method).
    // 2. Call Service A (GET /auth/verify) passing W3C traceparent headers.
    // 3. Call Service B (POST /inventory/reserve) passing W3C traceparent headers.
    // 4. Call Service D (POST /payments/charge) passing W3C traceparent headers.
    // 5. If any step fails, trigger compensating transactions (POST /inventory/release).
    // 6. Return 201 Created { order_id, status: "CONFIRMED" }.
    const fail = (status: number, message: string) => {
      res.status(status).json({ error: 'Checkout failed', message, status_code: status });
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

    const incomingTrace = req.header('traceparent');
    const validTrace = incomingTrace && /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(incomingTrace)
      && !incomingTrace.split('-').slice(1, 3).some((id) => /^0+$/.test(id));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      traceparent: validTrace ? incomingTrace! : `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    };
    if (validTrace && req.header('tracestate')) headers.tracestate = req.header('tracestate')!;
    const orderId = `ORD-${randomUUID()}`;
    let reservationId: string | undefined;
    let paymentStarted = false;
    const releaseInventory = async () => {
      try {
        const response = await fetch(`${CATALOG_SERVICE_URL}/inventory/release`, {
          method: 'POST', headers, body: JSON.stringify({ reservation_id: reservationId }),
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch { return false; }
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
      headers.baggage = `user_id=${encodeURIComponent(auth.user_id)}`;

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
        if (!await releaseInventory()) { fail(502, 'Payment failed and inventory release failed'); return; }
        res.status(402).json({ order_id: orderId, status: 'FAILED', message: 'Payment declined; inventory released' });
        return;
      }
      if (!paymentResponse.ok || payment?.status !== 'SUCCESS' || typeof payment.transaction_id !== 'string' || !payment.transaction_id) {
        fail(502, `Payment outcome unknown; reservation ${reservationId} retained`); return;
      }
      res.status(201).json({
        order_id: orderId, status: 'CONFIRMED', total_cents: totalCents,
        reservation_id: reservationId, transaction_id: payment.transaction_id,
      });
    } catch {
      if (reservationId && !paymentStarted && !await releaseInventory()) {
        fail(502, 'Checkout failed and inventory release failed'); return;
      }
      // A lost payment response does not prove the charge failed. Do not release stock blindly.
      fail(503, paymentStarted ? `Payment outcome unknown; reservation ${reservationId} retained` : 'A checkout dependency is unavailable');
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Downstream targets: Auth=${AUTH_SERVICE_URL}, Catalog=${CATALOG_SERVICE_URL}, Payment=${PAYMENT_SERVICE_URL}`);
});
