// Initialize telemetry before loading Express so automatic instrumentation attaches.
import './instrumentation';
import { prometheusExporter } from './instrumentation';
import { trace, SpanStatusCode } from '@opentelemetry/api';
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
import { log } from './logger';
import { requestTelemetry, errorHandler } from './observability';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';
const tracer = trace.getTracer(SERVICE_NAME);

app.use(requestTelemetry);
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
 * Unauthenticated Prometheus exposition endpoint for OpenTelemetry metrics.
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * GET /products
 * Purpose: Returns product list with stock counts.
 */
app.get('/products', (_req: Request, res: Response<Product[] | ErrorResponse>) => {
  return tracer.startActiveSpan('catalog.products.list', (span) => {
    try {
      res.status(200).json(products);
    } finally {
      span.end();
    }
  });
});

/**
 * POST /inventory/reserve
 * Purpose: Locks requested items in stock.
 */
app.post(
    '/inventory/reserve',
    (req: Request<{}, {}, ReserveRequest>, res: Response<ReserveResponse | ErrorResponse>) => {
      return tracer.startActiveSpan('inventory.reserve', (span) => {
        try {
          const items = req.body.items;
          let isRequestValid = true;
          items.forEach(item => {
            products.forEach(stockItem => {
              if (stockItem.id == item.product_id && stockItem.stock < item.quantity) {
                isRequestValid = false;
                span.setAttribute('inventory.outcome', 'conflict');
                log('warn', 'inventory.reserve.conflict', { product_id: item.product_id });
                return res.status(409).json({
                  "reservation_id": randomUUID(),
                  "status": "conflict",
                  "message": `The item ${stockItem.name} is out of stock`
                });
              }
            });
          });

          // Reservation is approved, we save it and return
          if (isRequestValid) {
            const reservationId = randomUUID();
            app.get('reservationStore').set(reservationId, items);
            res.locals.reservation_id = reservationId;
            span.setAttribute('reservation.id', reservationId);
            span.setAttribute('inventory.outcome', 'reserved');

            items.forEach(item => {
              products.forEach(stockItem => {
                if (stockItem.id == item.product_id) {
                  stockItem.stock -= item.quantity;
                }
              });
            });

            log('info', 'inventory.reserve.completed', { reservation_id: reservationId });
            return res.status(200).json({
              "reservation_id": reservationId,
              "status": "reserved"
            });
          }
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    }
);

/**
 * POST /inventory/release
 * Purpose: Releases previously reserved stock on rollback / checkout abort.
 */
app.post(
  '/inventory/release',
  (req: Request<{}, {}, ReleaseRequest>, res: Response<ReleaseResponse | ErrorResponse>) => {
    return tracer.startActiveSpan('inventory.release', (span) => {
      try {
        const reservationId = req.body.reservation_id;
        res.locals.reservation_id = reservationId;
        if (typeof reservationId === 'string') {
          span.setAttribute('reservation.id', reservationId);
        }
        const reservations: ReservationItem[] = app.get("reservationStore").get(reservationId);
        reservations.forEach(reservation => {
          products.forEach(product => {
            if (product.id == reservation.product_id) {
              product.stock += reservation.quantity;
            }
          });
        });
        app.get("reservationStore").delete(reservationId);

        span.setAttribute('inventory.outcome', 'released');
        log('info', 'inventory.release.completed', { reservation_id: reservationId });
        res.status(200).json({
          "reservation_id": reservationId,
          "status": "released"
        });
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setAttribute('inventory.outcome', 'release_failed');
        log('warn', 'inventory.release.failed', {
          reservation_id: res.locals.reservation_id,
          error_message: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({
          "error": "Release unsuccessful",
          "message": "The reservation release was unsuccessful",
          "status_code": 400
        });
      } finally {
        span.end();
      }
    });
  }
);

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  log('info', 'service.started', { port: PORT });
});
