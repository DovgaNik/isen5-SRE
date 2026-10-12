import express, { Request, Response } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const SERVICE_NAME = 'service-a-auth';
// Demo credentials for this lab. An unset JWT_SECRET creates a secret for this process only.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const DEMO_USER = { username: 'demo', password: 'DemoPassword123!', user_id: 'USER-1' };

function setUserContext(req: Request, res: Response, userId: string) {
  const incoming = req.header('traceparent');
  const validTrace = incoming && /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(incoming)
    && !incoming.split('-').slice(1, 3).some((id) => /^0+$/.test(id));
  res.setHeader('traceparent', validTrace ? incoming! : `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`);
  if (validTrace && req.header('tracestate')) res.setHeader('tracestate', req.header('tracestate')!);
  res.setHeader('baggage', `user_id=${encodeURIComponent(userId)}`);
}

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
// Service Endpoints
// ==========================================

/**
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Validate credentials payload.
  // 2. Issue signed JWT/session token containing user ID.
  // 3. Inject trace context and baggage.
  // 4. Return TokenResponse (200 OK) or Unauthorized (401).
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'Bad Request', message: 'username and password are required', status_code: 400 });
    return;
  }
  if (username !== DEMO_USER.username || password !== DEMO_USER.password) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials', status_code: 401 });
    return;
  }

  const token = jwt.sign({ roles: ['customer'] }, JWT_SECRET, {
    algorithm: 'HS256', subject: DEMO_USER.user_id, expiresIn: 900,
    issuer: 'cloudstore-auth', audience: 'cloudstore',
  });
  setUserContext(req, res, DEMO_USER.user_id);
  res.status(200).json({ token, user_id: DEMO_USER.user_id, expires_in: 900 });
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Extract Bearer token from req.headers.authorization.
  // 2. Verify signature and expiry.
  // 3. Inject user context into span / baggage.
  // 4. Return AuthVerifyResponse (200 OK) or Unauthorized (401).
  const token = req.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized', message: 'Bearer token is required', status_code: 401 });
    return;
  }

  try {
    const claims = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'], issuer: 'cloudstore-auth', audience: 'cloudstore',
    });
    if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number') {
      throw new Error('Invalid token claims');
    }
    setUserContext(req, res, claims.sub);
    res.status(200).json({ valid: true, user_id: claims.sub, roles: ['customer'] });
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token', status_code: 401 });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
