import express, { Request, Response } from 'express';
import cors from 'cors';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const SERVICE_NAME = 'service-a-auth';

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
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Validate credentials payload.
  // 2. Issue signed JWT/session token containing user ID.
  // 3. Inject trace context and baggage.
  // 4. Return TokenResponse (200 OK) or Unauthorized (401).
  res.status(501).json({
    error: 'Not Implemented',
    message: 'POST /auth/login is not implemented in this skeleton. Implement authentication logic before day 2.',
    status_code: 501,
  });
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 * Skeleton: Returns 501 Not Implemented.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Extract Bearer token from req.headers.authorization.
  // 2. Verify signature and expiry.
  // 3. Inject user context into span / baggage.
  // 4. Return AuthVerifyResponse (200 OK) or Unauthorized (401).
  res.status(501).json({
    error: 'Not Implemented',
    message: 'GET /auth/verify is not implemented in this skeleton. Implement token verification logic before day 2.',
    status_code: 501,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
