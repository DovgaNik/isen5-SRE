import express, { Request, Response } from 'express';
import cors from 'cors';
import {
  Product,
  ReserveRequest,
  ReserveResponse,
  ReleaseRequest,
  ReleaseResponse,
  ErrorResponse,
} from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';

app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
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
 * GET /products
 * Purpose: Returns product list with stock counts.
 * Skeleton: Returns 501 Not Implemented.
 */
app.get('/products', (_req: Request, res: Response<Product[] | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Fetch available products and inventory levels from catalog repository.
  // 2. Return product list (200 OK).
  res.status(501).json({
    error: 'Not Implemented',
    message: 'GET /products is not implemented in this skeleton. Implement catalog retrieval before day 2.',
    status_code: 501,
  });
});

/**
 * POST /inventory/reserve
 * Purpose: Locks requested items in stock.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post(
  '/inventory/reserve',
  (req: Request<{}, {}, ReserveRequest>, res: Response<ReserveResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    // 1. Validate requested items and stock availability.
    // 2. Atomically acquire lock / reserve items in stock.
    // 3. Return 200 OK with reservation_id or 409 Conflict if stock is insufficient.
    res.status(501).json({
      error: 'Not Implemented',
      message: 'POST /inventory/reserve is not implemented in this skeleton. Implement stock reservation before day 2.',
      status_code: 501,
    });
  }
);

/**
 * POST /inventory/release
 * Purpose: Releases previously reserved stock on rollback / checkout abort.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post(
  '/inventory/release',
  (req: Request<{}, {}, ReleaseRequest>, res: Response<ReleaseResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    // 1. Look up reservation by reservation_id.
    // 2. Release locked items back to stock inventory.
    // 3. Return 200 OK with confirmation.
    res.status(501).json({
      error: 'Not Implemented',
      message: 'POST /inventory/release is not implemented in this skeleton. Implement stock release before day 2.',
      status_code: 501,
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
