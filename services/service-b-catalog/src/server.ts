import express, {Request, Response} from 'express';
import cors from 'cors';
import {
  Product,
  ReserveRequest,
  ReserveResponse,
  ReleaseRequest,
  ReleaseResponse,
  ErrorResponse,
  ReservationItem,
} from './types';
import {products} from "./products";
import {randomUUID} from "node:crypto";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';

app.use(cors());
app.use(express.json());
app.set("reservationStore", new Map<string, ReservationItem[]>);

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
 */
app.get('/products', (_req: Request, res: Response<Product[] | ErrorResponse>) => {
  res.status(200).json(products);
});

/**
 * POST /inventory/reserve
 * Purpose: Locks requested items in stock.
 */
app.post(
    '/inventory/reserve',
    (req: Request<{}, {}, ReserveRequest>, res: Response<ReserveResponse | ErrorResponse>) => {
      const items = req.body.items;
      items.forEach(item => {
        products.forEach(stockItem => {
          if (stockItem.id == item.product_id && stockItem.stock < item.quantity) {
            return res.status(409).json({
              "reservation_id": randomUUID(),
              "status": "conflict",
              "message": `The item ${stockItem.name} is out of stock`
            });
          }
        });
      });

      // Reservation is approved, we save it and return
      const reservationId = randomUUID();
      app.get('reservationStore').set(reservationId, items);

      items.forEach(item => {
        products.forEach(stockItem => {
          if (stockItem.id == item.product_id) {
            stockItem.stock = stockItem.stock - item.quantity;
          }
        });
      });

      return res.status(200).json({
        "reservation_id": reservationId,
        "status": "reserved"
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
