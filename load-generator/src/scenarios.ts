import type { RequestRecord, ScenarioDefinition } from './types';

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'checkout-saga',
    name: 'Full Checkout Saga (Nominal)',
    description: 'Executes standard customer checkouts via Service C, orchestrating Auth token check, Catalog stock lock, and Payment charging.',
    defaultIntervalMs: 500,
    targetService: 'order',
  },
  {
    id: 'nominal-browsing',
    name: 'Catalog Browsing & Sessions',
    description: 'Simulates store visitors browsing product inventory (Service B) and refreshing user sessions (Service A).',
    defaultIntervalMs: 250,
    targetService: 'catalog',
  },
  {
    id: 'peak-traffic',
    name: 'Peak Shopping Surge',
    description: 'High-frequency purchase burst simulating flash sales and rush hours to measure concurrency and latency queues.',
    defaultIntervalMs: 100,
    targetService: 'order',
  },
  {
    id: 'out-of-stock',
    name: 'Out-of-Stock Purchase (409)',
    description: 'Authenticates, then requests more than a real product’s available stock, expecting 409 before payment.',
    defaultIntervalMs: 400,
    targetService: 'order',
  },
  {
    id: 'custom-single',
    name: 'Custom Endpoint Ping',
    description: 'Send custom requests directly to any specified microservice and route.',
    defaultIntervalMs: 300,
    targetService: 'custom',
  },
];

export interface EndpointsConfig {
  serviceA: string;
  serviceB: string;
  serviceC: string;
  serviceD: string;
  customUrl: string;
  customMethod: string;
  customBody: string;
}

export function generateTraceContext(): { traceId: string; spanId: string; header: string } {
  const hex = (bytes: number) => {
    const value = crypto.getRandomValues(new Uint8Array(bytes));
    // W3C trace/span identifiers must not be all zeroes.
    if (value.every((byte) => byte === 0)) value[0] = 1;
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const traceId = hex(16);
  const spanId = hex(8);
  const header = `00-${traceId}-${spanId}-01`;
  return { traceId, spanId, header };
}

let counter = 0;

interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

interface Product {
  id: string;
  stock: number;
}

// Cache only in memory, keyed by auth endpoint. Concurrent clicks share a login.
const sessions = new Map<string, Promise<Session>>();
const baseUrl = (url: string) => url.replace(/\/+$/, '');

async function getSession(authUrl: string): Promise<Session> {
  const key = baseUrl(authUrl);
  const cached = sessions.get(key);
  if (cached) {
    const session = await cached;
    if (session.expiresAt > Date.now()) return session;
    if (sessions.get(key) === cached) sessions.delete(key);
    return getSession(key);
  }
  const pending = (async () => {
    const response = await fetch(`${key}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'DemoPassword123!' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}) at ${key}/auth/login`);
    const data = await response.json();
    if (typeof data.token !== 'string' || !data.token || typeof data.user_id !== 'string'
      || !data.user_id || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('Auth service returned an invalid login response');
    }
    return {
      token: data.token,
      userId: data.user_id,
      expiresAt: Date.now() + data.expires_in * 1000 - Math.min(30000, data.expires_in * 100),
    };
  })();
  sessions.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (sessions.get(key) === pending) sessions.delete(key);
    throw error;
  }
}

async function getProducts(catalogUrl: string): Promise<Product[]> {
  const response = await fetch(`${baseUrl(catalogUrl)}/products`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Catalog lookup failed (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!Array.isArray(data) || !data.length || data.some((product) => !product
    || typeof product.id !== 'string' || !product.id
    || !Number.isSafeInteger(product.stock) || product.stock < 0)) {
    throw new Error('Catalog service returned invalid products');
  }
  return data;
}

export async function executeScenarioStep(
  scenarioId: string,
  endpoints: EndpointsConfig,
  injectTraceContext: boolean
): Promise<RequestRecord> {
  counter++;
  const id = `req-${Date.now()}-${counter}`;
  const timestamp = new Date().toISOString();

  let method = 'GET';
  let url = '';
  let body: unknown = undefined;
  let traceId: string | undefined = undefined;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (injectTraceContext) {
    const ctx = generateTraceContext();
    headers['traceparent'] = ctx.header;
    headers['x-client-request-id'] = id;
    traceId = ctx.traceId;
  }

  const step = counter;
  const startTime = performance.now();
  let status = 0;
  let responseBody: unknown = null;
  let errorMsg: string | undefined = undefined;

  try {
    switch (scenarioId) {
      case 'checkout-saga':
      case 'peak-traffic':
      case 'out-of-stock': {
        method = 'POST';
        url = `${baseUrl(endpoints.serviceC)}/orders/checkout`;
        const session = await getSession(endpoints.serviceA);
        headers['Authorization'] = `Bearer ${session.token}`;
        const products = await getProducts(endpoints.serviceB);
        const candidates = scenarioId === 'out-of-stock'
          ? products.filter((product) => Number.isSafeInteger(product.stock + 1))
          : products.filter((product) => product.stock > 0);
        if (!candidates.length) {
          throw new Error('No usable inventory remains. Restock/reset the demo catalog before sending more checkouts.');
        }
        // Rotate across the entire real catalog rather than draining IDs 1–5.
        const product = candidates[(step - 1) % candidates.length];
        body = {
          user_id: session.userId,
          items: [{ product_id: product.id, quantity: scenarioId === 'out-of-stock' ? product.stock + 1 : 1 }],
          payment_method: 'card',
        };
        break;
      }

      case 'nominal-browsing': {
        const mode = step % 2;
        if (mode === 0) {
          method = 'GET';
          url = `${baseUrl(endpoints.serviceB)}/products`;
        } else {
          method = 'GET';
          url = `${baseUrl(endpoints.serviceA)}/auth/verify`;
          const session = await getSession(endpoints.serviceA);
          headers['Authorization'] = `Bearer ${session.token}`;
        }
        break;
      }

      case 'custom-single':
      default: {
        method = endpoints.customMethod || 'GET';
        url = endpoints.customUrl || `${baseUrl(endpoints.serviceA)}/healthz`;
        if (method !== 'GET' && method !== 'HEAD' && endpoints.customBody) {
          try {
            body = JSON.parse(endpoints.customBody);
          } catch {
            body = { raw: endpoints.customBody };
          }
        }
        break;
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(20000),
    };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(body);
    }

    const resp = await fetch(url, fetchOptions);
    status = resp.status;
    // Re-authenticate on the next step, never automatically replay a checkout:
    // a lost response may hide a completed payment.
    if (status === 401 && headers['Authorization']) sessions.delete(baseUrl(endpoints.serviceA));
    const text = await resp.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  } catch (err) {
    status = 0;
    errorMsg = (err as Error).message || 'Network request failed';
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    id,
    timestamp,
    scenarioName: SCENARIOS.find((s) => s.id === scenarioId)?.name || scenarioId,
    method,
    url,
    status,
    durationMs,
    traceId,
    requestHeaders: {
      ...headers,
      ...(headers['Authorization'] ? { Authorization: 'Bearer [REDACTED]' } : {}),
    },
    requestBody: body,
    responseBody,
    error: errorMsg,
  };
}
