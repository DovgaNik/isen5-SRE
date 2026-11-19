# CloudStore Load Generator & Scenario Injector

The **CloudStore Load Generator** is an interactive, browser-based traffic simulation dashboard designed for the ISEN5 SRE course.

Inspired by `error-rate-visu`, it allows students and instructors to generate synthetic e-commerce traffic, checkout sagas, concurrency bursts, and failure modes across the CloudStore microservices—**without introducing any client-side observability libraries** (telemetry is captured strictly on the microservices by the students).

---

## Features

- **Scenario Selector & Presets**:
  - **Full Checkout Saga**: Fires orders through Service C (`POST /orders/checkout`), exercising the distributed checkout flow across Auth, Catalog, and Payment.
  - **Catalog Browsing**: Interleaved product browsing and session verification.
  - **Peak Shopping Surge**: High-rate traffic burst to test concurrency queues and response times under load.
   - **Out-of-Stock (409)**: Authenticates and requests more than a known product's stock, testing `409 Conflict` before payment.
  - **Custom Endpoint Ping**: Freely target any individual microservice and endpoint with custom methods and payloads.
- **Pacing & Concurrency Controls**:
  - Live interval slider: from 50 ms (~20 req/s) to 2000 ms (~0.5 req/s).
  - Modern toggle switch with visual glowing running status.
  - Single-request trigger button for step-by-step debugging.
- **Distributed Tracing Support**:
  - Toggle W3C `traceparent` generation: generates standard `00-{traceId}-{spanId}-01` root context sent in HTTP headers.
- **Real-Time Client Telemetry Cards**:
  - 6 dedicated KPI metric cards: Total Requests, `2xx Success Rate`, `4xx Client Errors`, `5xx / 501 Skeleton Errors`, Average Latency with tier badge, and live Throughput (req/s).
- **Interactive Live Response Stream**:
  - Filterable stream (`All`, `2xx`, `4xx`, `5xx`) with live entry counter.
  - Expandable transaction cards revealing complete outgoing request headers, body, and received response payload JSON.

---

## Running the Load Generator

### Option 1: Via Docker Compose (Recommended)
From the root `cloudstore/` directory:
```bash
docker compose up load-generator -d
```
Open your browser at **[http://localhost:8080](http://localhost:8080)**.

### Option 2: Local Development Mode
From the `cloudstore/load-generator/` directory:
```bash
npm ci
npm run dev
```
Open **[http://localhost:8080](http://localhost:8080)**.

## Full checkout traces in Jaeger

Checkout and peak scenarios automatically log in with the project's demo account
(`demo` / `DemoPassword123!`), cache/refresh the token in memory, and send the returned
user ID. They fetch the actual catalog and rotate single-item purchases across products
with available stock. Browsing also uses a valid token for authentication checks.
Bearer tokens are redacted in the UI's request records.

After changing code, rebuild the UI and order service from the repository root:

```bash
docker compose up -d --build --no-deps service-c load-generator
```

With Podman, use `podman compose` instead. If the other services are not running yet,
start the full stack first with `docker compose up -d --build`.

Refresh the browser at `http://localhost:8080`, keep **Trace Context** enabled, select
**Full Checkout Saga (Nominal)**, and click **Fire Single Request**. Click the purple
trace ID to open its Jaeger waterfall on port 16686 of the same host. Allow a few seconds
for batched exports. A checkout reaching payment contains A/B/C/D in the same trace:

```text
C — POST /orders/checkout
├── A — GET /auth/verify
├── B — GET /products
├── B — POST /inventory/reserve
└── D — POST /payments/charge
```

The payment mock still deliberately declines approximately 10% of payments (`402`);
these traces also include all four services and inventory compensation. C's payment
deadline is 5 seconds, longer than the mock's maximum 4-second delay. Unknown payment
outcomes are not retried automatically.

Successful purchases consume real in-memory stock. The generator does not secretly
restock or release confirmed purchases. Once all products are exhausted it reports
that inventory must be replenished. Concurrent buyers can still legitimately race
for the last item and receive `409`.

## Regression checks

After `npm ci` in this directory, run `npm test` for generator unit checks.
From the repository root, after building all four services:

```bash
node --test tests/load-generator.test.cjs tests/observability.test.cjs
```

To send **one real checkout** through the running stack and verify the exported
trace and its cross-service parent/child links in Jaeger:

```bash
node tests/live-checkout.cjs
```

This opt-in smoke check consumes one item on success; it does not reset inventory
or retry payments. A simulated decline is also accepted if all four services are traced.
