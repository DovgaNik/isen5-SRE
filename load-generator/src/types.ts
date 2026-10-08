export interface RequestRecord {
  id: string;
  timestamp: string;
  scenarioName: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  traceId?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
}

export interface Stats {
  total: number;
  ok2xx: number;
  clientError4xx: number;
  serverError5xx: number;
  otherError: number;
  totalDurationMs: number;
  recentRps: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  defaultIntervalMs: number;
  targetService: 'gateway' | 'catalog' | 'order' | 'payment' | 'custom';
}

export type StatusFilter = 'all' | '2xx' | '4xx' | '5xx';

