// Initialize telemetry before loading Express so automatic instrumentation attaches.
import './instrumentation';
import { prometheusExporter } from './instrumentation';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ChargeRequest, ChargeResponse, ErrorResponse } from './types';
import {randomUUID} from "node:crypto";
import { log } from './logger';
import { requestTelemetry, errorHandler } from './observability';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8084;
const SERVICE_NAME = 'service-d-payment';
const tracer = trace.getTracer(SERVICE_NAME);

app.use(requestTelemetry);
app.use(cors());
app.use(express.json());
app.set("idempotencyStore", new Map<string, ChargeResponse | ErrorResponse>); // This is needed to avoid using smth like Redis or a DB to store the processed keys

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
 * POST /payments/charge
 * Purpose: Simulates payment authorization with idempotency keys.
 */
app.post(
  '/payments/charge',
  async (req: Request<{}, {}, ChargeRequest>, res: Response<ChargeResponse | ErrorResponse>, next: NextFunction) => {
    return tracer.startActiveSpan('payments.charge', async (span) => {
      try {
        if (typeof req.body?.order_id === 'string') {
          span.setAttribute('order.id', req.body.order_id);
          res.locals.order_id = req.body.order_id;
        }
        const delay = Math.floor(Math.random() * 2000);
        await new Promise(f => setTimeout(f, delay));
        if (!app.get("idempotencyStore").has(req.body.idempotency_key)) {
          let response: ChargeResponse;
          const isPaymentSuccess = Math.random() > 0.1;
          if (isPaymentSuccess) {
            response = {
              transaction_id: randomUUID(),
              status: "SUCCESS",
            };
          } else {
            const isDeclined = Math.random() > 0.5;
            response = {
              transaction_id: randomUUID(),
              status: isDeclined ? "FAILED_DECLINED" : "FAILED_INSUFFICIENT_FUNDS",
            };
          }

          app.get("idempotencyStore").set(req.body.idempotency_key, response);
          res.locals.transaction_id = response.transaction_id;
          span.setAttribute('payment.transaction_id', response.transaction_id);
          span.setAttribute('payment.outcome', response.status);
          log(response.status === 'SUCCESS' ? 'info' : 'warn', 'payments.charge.completed', {
            order_id: res.locals.order_id,
            transaction_id: response.transaction_id,
            outcome: response.status,
          });
          return res.status(200).json(response);
        } else {
          span.setAttribute('payment.outcome', 'duplicate_rejected');
          log('warn', 'payments.charge.duplicate', { order_id: res.locals.order_id });
          return res.status(400).json({
            transaction_id: randomUUID(),
            status: "FAILED_DECLINED",
          });
        }
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        next(error);
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
