import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import client from 'prom-client';
import { trace, context } from '@opentelemetry/api';
import { randomBytes } from 'node:crypto';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';
import { log } from './logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const SERVICE_NAME = 'service-a-auth';
const tracer = trace.getTracer(SERVICE_NAME, '1.0');

// Demo credentials for this lab. An unset JWT_SECRET creates a secret for this process only.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const DEMO_USER = { username: 'demo', password: 'DemoPassword123!', user_id: 'USER-1' };

function setUserContext(req: Request, res: Response, userId: string) {
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttribute('user.id', userId);
  }

  const incoming = req.header('traceparent');
  const validTrace = incoming && /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(incoming)
    && !incoming.split('-').slice(1, 3).some((id) => /^0+$/.test(id));
  res.setHeader('traceparent', validTrace ? incoming! : `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`);
  if (validTrace && req.header('tracestate')) res.setHeader('tracestate', req.header('tracestate')!);
  res.setHeader('baggage', `user_id=${encodeURIComponent(userId)}`);
}

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

// ─── Business Endpoints ────────────────────────────────────────────

/**
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  tracer.startActiveSpan('auth.login', (span) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
        span.setAttribute('auth.status', 'bad_request');
        log('warn', 'Login rejected: missing credentials');
        res.status(400).json({ error: 'Bad Request', message: 'username and password are required', status_code: 400 });
        return;
      }
      if (username !== DEMO_USER.username || password !== DEMO_USER.password) {
        span.setAttribute('auth.status', 'unauthorized');
        log('warn', 'Login failed: invalid credentials', { username });
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials', status_code: 401 });
        return;
      }

      const token = jwt.sign({ roles: ['customer'] }, JWT_SECRET, {
        algorithm: 'HS256', subject: DEMO_USER.user_id, expiresIn: 900,
        issuer: 'cloudstore-auth', audience: 'cloudstore',
      });
      setUserContext(req, res, DEMO_USER.user_id);

      span.setAttribute('auth.status', 'success');
      span.setAttribute('user.id', DEMO_USER.user_id);
      log('info', 'User login successful', { user_id: DEMO_USER.user_id });

      res.status(200).json({ token, user_id: DEMO_USER.user_id, expires_in: 900 });
    } catch (err: unknown) {
      span.recordException(err as Error);
      log('error', 'Login error', { error: String(err) });
      res.status(500).json({ error: 'Internal Server Error', message: 'Authentication error', status_code: 500 });
    } finally {
      span.end();
    }
  });
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  tracer.startActiveSpan('auth.verify', (span) => {
    try {
      const token = req.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) {
        span.setAttribute('auth.status', 'missing_token');
        log('warn', 'Token verification failed: Bearer token is required');
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
        span.setAttribute('auth.status', 'valid');
        span.setAttribute('user.id', claims.sub);
        log('info', 'Token verified', { user_id: claims.sub });
        res.status(200).json({ valid: true, user_id: claims.sub, roles: ['customer'] });
      } catch {
        span.setAttribute('auth.status', 'invalid_token');
        log('warn', 'Token verification failed: invalid or expired token');
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token', status_code: 401 });
      }
    } finally {
      span.end();
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', `Listening on port ${PORT}`);
});
