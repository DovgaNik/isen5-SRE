import express, { Request, Response } from 'express';
import cors from 'cors';
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
// Service Endpoints (Skeleton - Unimplemented)
// ==========================================

/**
 * POST /orders/checkout
 * Purpose: Coordinates distributed checkout transaction saga.
 * Workflow to implement:
 *   1. Authenticate user via Service A (GET /auth/verify) with trace context.
 *   2. Reserve inventory via Service B (POST /inventory/reserve) with trace context.
 *   3. Charge customer via Service D (POST /payments/charge) with trace context.
 *   4. Return 201 Created with { "order_id": "ORD-...", "status": "CONFIRMED" }.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post(
  '/orders/checkout',
  (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    // 1. Validate incoming checkout payload (user_id, items, payment_method).
    // 2. Call Service A (GET /auth/verify) passing W3C traceparent headers.
    // 3. Call Service B (POST /inventory/reserve) passing W3C traceparent headers.
    // 4. Call Service D (POST /payments/charge) passing W3C traceparent headers.
    // 5. If any step fails, trigger compensating transactions (POST /inventory/release).
    // 6. Return 201 Created { order_id, status: "CONFIRMED" }.
    res.status(501).json({
      error: 'Not Implemented',
      message: 'POST /orders/checkout is not implemented in this skeleton. Implement checkout orchestration saga before day 2.',
      status_code: 501,
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Downstream targets: Auth=${AUTH_SERVICE_URL}, Catalog=${CATALOG_SERVICE_URL}, Payment=${PAYMENT_SERVICE_URL}`);
});
