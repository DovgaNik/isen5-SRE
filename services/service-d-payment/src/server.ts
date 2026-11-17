import express, { Request, Response } from 'express';
import cors from 'cors';
import { ChargeRequest, ChargeResponse, ErrorResponse } from './types';
import {randomUUID} from "node:crypto";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8084;
const SERVICE_NAME = 'service-d-payment';

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
 * POST /payments/charge
 * Purpose: Simulates payment authorization with idempotency keys.
 */
app.post(
  '/payments/charge',
    async (req: Request<{}, {}, ChargeRequest>, res: Response<ChargeResponse | ErrorResponse>) => {
    const delay = Math.floor(Math.random() * 4000);
    await new Promise(f => setTimeout(f, delay))
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
      return res.status(200).json(response);
    } else {
      return res.status(400).json(
          {
            transaction_id: randomUUID(),
            status: "FAILED_DECLINED",
          }
      );
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
