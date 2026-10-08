# CloudStore Load Generator & Scenario Injector

The **CloudStore Load Generator** is an interactive, browser-based traffic simulation dashboard designed for the ISEN5 SRE course.

Inspired by `error-rate-visu`, it allows students and instructors to generate synthetic e-commerce traffic, checkout sagas, concurrency bursts, and failure modes across the CloudStore microservices—**without introducing any client-side observability libraries** (telemetry is captured strictly on the microservices by the students).

---

## Features

- **Scenario Selector & Presets**:
  - **Full Checkout Saga**: Fires orders through Service C (`POST /orders/checkout`), exercising the distributed checkout flow across Auth, Catalog, and Payment.
  - **Catalog Browsing**: Interleaved product browsing and session verification.
  - **Peak Shopping Surge**: High-rate traffic burst to test concurrency queues and response times under load.
  - **Out-of-Stock (409)**: Requests excessive quantities to test `409 Conflict` handling and saga compensation.
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
npm install
npm run dev
```
Open **[http://localhost:8080](http://localhost:8080)**.
