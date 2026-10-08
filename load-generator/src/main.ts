import './style.css';
import { SCENARIOS, EndpointsConfig, executeScenarioStep } from './scenarios';
import { RequestRecord, Stats, StatusFilter } from './types';

let currentScenarioId = 'checkout-saga';
let isRunning = false;
let intervalMs = 500;
let injectTrace = true;
let currentFilter: StatusFilter = 'all';
let timerId: ReturnType<typeof setTimeout> | null = null;

const stats: Stats = {
  total: 0,
  ok2xx: 0,
  clientError4xx: 0,
  serverError5xx: 0,
  otherError: 0,
  totalDurationMs: 0,
  recentRps: 0,
};

const allRecords: RequestRecord[] = [];
const recentTimestamps: number[] = [];

// DOM Elements
const scenarioSelect = document.getElementById('scenarioSelect') as HTMLSelectElement;
const scenarioDesc = document.getElementById('scenarioDesc') as HTMLElement;
const trafficToggle = document.getElementById('trafficToggle') as HTMLInputElement;
const toggleStatus = document.getElementById('toggleStatus') as HTMLElement;
const pulseDot = document.getElementById('pulseDot') as HTMLElement;
const sendSingleBtn = document.getElementById('sendSingleBtn') as HTMLButtonElement;
const resetStatsBtn = document.getElementById('resetStatsBtn') as HTMLButtonElement;
const clearLogsBtn = document.getElementById('clearLogsBtn') as HTMLButtonElement;
const intervalSlider = document.getElementById('intervalSlider') as HTMLInputElement;
const intervalBadge = document.getElementById('intervalBadge') as HTMLElement;
const traceContextToggle = document.getElementById('traceContextToggle') as HTMLInputElement;

const endpointA = document.getElementById('endpointA') as HTMLInputElement;
const endpointB = document.getElementById('endpointB') as HTMLInputElement;
const endpointC = document.getElementById('endpointC') as HTMLInputElement;
const endpointD = document.getElementById('endpointD') as HTMLInputElement;

// KPI Card Elements
const statTotal = document.getElementById('statTotal') as HTMLElement;
const stat2xx = document.getElementById('stat2xx') as HTMLElement;
const stat4xx = document.getElementById('stat4xx') as HTMLElement;
const stat5xx = document.getElementById('stat5xx') as HTMLElement;
const statLatency = document.getElementById('statLatency') as HTMLElement;
const statRps = document.getElementById('statRps') as HTMLElement;

const badge2xx = document.getElementById('badge2xx') as HTMLElement;
const badge4xx = document.getElementById('badge4xx') as HTMLElement;
const badge5xx = document.getElementById('badge5xx') as HTMLElement;
const badgeLatency = document.getElementById('badgeLatency') as HTMLElement;

// Stream Elements
const streamCounter = document.getElementById('streamCounter') as HTMLElement;
const filterPills = document.getElementById('filterPills') as HTMLElement;
const logContainer = document.getElementById('logContainer') as HTMLElement;

function getEndpoints(): EndpointsConfig {
  return {
    serviceA: endpointA.value.trim() || 'http://localhost:8081',
    serviceB: endpointB.value.trim() || 'http://localhost:8082',
    serviceC: endpointC.value.trim() || 'http://localhost:8083',
    serviceD: endpointD.value.trim() || 'http://localhost:8084',
    customUrl: '',
    customMethod: 'GET',
    customBody: '',
  };
}

function initScenarios() {
  scenarioSelect.innerHTML = '';
  SCENARIOS.forEach((sc) => {
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = sc.name;
    scenarioSelect.appendChild(opt);
  });
  updateScenarioDetails(currentScenarioId);
}

function updateScenarioDetails(id: string) {
  currentScenarioId = id;
  scenarioSelect.value = id;
  const def = SCENARIOS.find((s) => s.id === id);
  if (def) {
    scenarioDesc.textContent = def.description;
    intervalSlider.value = def.defaultIntervalMs.toString();
    updateIntervalBadge(def.defaultIntervalMs);
  }

  document.querySelectorAll<HTMLButtonElement>('.preset-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scenario === id);
  });
}

function updateIntervalBadge(val: number) {
  intervalMs = val;
  const approxRps = (1000 / val).toFixed(val < 200 ? 0 : 1);
  intervalBadge.textContent = `${val} ms (~${approxRps} req/s)`;
}

function updateStatsUI() {
  statTotal.textContent = stats.total.toLocaleString();
  stat2xx.textContent = stats.ok2xx.toLocaleString();
  stat4xx.textContent = stats.clientError4xx.toLocaleString();
  stat5xx.textContent = stats.serverError5xx.toLocaleString();

  const pct = (val: number) => (stats.total > 0 ? `${Math.round((val / stats.total) * 100)}%` : '0%');
  badge2xx.textContent = pct(stats.ok2xx);
  badge4xx.textContent = pct(stats.clientError4xx);
  badge5xx.textContent = pct(stats.serverError5xx);

  const avg = stats.total > 0 ? Math.round(stats.totalDurationMs / stats.total) : 0;
  statLatency.textContent = `${avg} ms`;

  if (avg < 50) {
    badgeLatency.textContent = 'Optimal';
  } else if (avg < 200) {
    badgeLatency.textContent = 'Nominal';
  } else {
    badgeLatency.textContent = 'Elevated';
  }

  // Calculate live RPS from past 2 seconds window
  const now = Date.now();
  while (recentTimestamps.length > 0 && recentTimestamps[0] < now - 2000) {
    recentTimestamps.shift();
  }
  const liveRps = (recentTimestamps.length / 2).toFixed(1);
  statRps.textContent = `${liveRps} req/s`;
}

function matchesFilter(rec: RequestRecord): boolean {
  if (currentFilter === 'all') return true;
  if (currentFilter === '2xx') return rec.status >= 200 && rec.status < 300;
  if (currentFilter === '4xx') return rec.status >= 400 && rec.status < 500;
  if (currentFilter === '5xx') return rec.status >= 500 || rec.status === 0;
  return true;
}

function formatJson(val: unknown): string {
  if (!val) return 'None';
  try {
    return typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function createStreamItemElement(rec: RequestRecord): HTMLElement {
  const item = document.createElement('div');
  item.className = 'stream-item';

  let statusClass = 'status-err';
  let statusText = rec.status === 0 ? 'ERR' : rec.status.toString();
  if (rec.status >= 200 && rec.status < 300) {
    statusClass = 'status-2xx';
  } else if (rec.status >= 400 && rec.status < 500) {
    statusClass = 'status-4xx';
  } else if (rec.status >= 500) {
    statusClass = 'status-5xx';
    if (rec.status === 501) statusText = '501 Not Implemented';
  }

  const timeStr = rec.timestamp.split('T')[1].slice(0, 8);
  const methodClass = rec.method === 'POST' ? 'method-post' : 'method-get';
  const traceDisplay = rec.traceId ? `trace:${rec.traceId.slice(0, 12)}…` : 'no-trace';

  item.innerHTML = `
    <div class="stream-item-summary">
      <span class="stream-time">${timeStr}</span>
      <span class="method-badge ${methodClass}">${rec.method}</span>
      <span class="status-badge ${statusClass}">${statusText}</span>
      <span class="stream-url" title="${rec.url}">${rec.url}</span>
      <span class="stream-latency">${rec.durationMs}ms</span>
      <span class="stream-trace" title="${rec.traceId || 'No trace context'}">${traceDisplay}</span>
      <span class="stream-chevron">▾</span>
    </div>
    <div class="stream-drawer">
      <div class="drawer-grid">
        <div class="drawer-column">
          <h4>Outgoing Request</h4>
          <pre class="drawer-code-block">${formatJson({
            scenario: rec.scenarioName,
            headers: rec.requestHeaders || {},
            body: rec.requestBody || null,
          })}</pre>
        </div>
        <div class="drawer-column">
          <h4>Received Response</h4>
          <pre class="drawer-code-block">${formatJson(rec.error ? { error: rec.error } : rec.responseBody)}</pre>
        </div>
      </div>
    </div>
  `;

  const summary = item.querySelector('.stream-item-summary') as HTMLElement;
  summary.addEventListener('click', () => {
    item.classList.toggle('expanded');
  });

  return item;
}

function renderLogs() {
  const filtered = allRecords.filter(matchesFilter);
  streamCounter.textContent = `${allRecords.length} logged`;

  if (filtered.length === 0) {
    logContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No Matching Records</div>
        <div class="empty-sub">No requests match the current <strong>${currentFilter.toUpperCase()}</strong> filter.</div>
      </div>
    `;
    return;
  }

  logContainer.innerHTML = '';
  filtered.forEach((rec) => {
    logContainer.appendChild(createStreamItemElement(rec));
  });
}

function appendLog(rec: RequestRecord) {
  allRecords.unshift(rec);
  if (allRecords.length > 150) {
    allRecords.pop();
  }

  streamCounter.textContent = `${allRecords.length} logged`;

  if (matchesFilter(rec)) {
    if (logContainer.querySelector('.empty-state')) {
      logContainer.innerHTML = '';
    }
    const elem = createStreamItemElement(rec);
    logContainer.insertBefore(elem, logContainer.firstChild);

    while (logContainer.children.length > 150) {
      logContainer.removeChild(logContainer.lastChild!);
    }
  }
}

async function triggerSingleRequest() {
  const rec = await executeScenarioStep(currentScenarioId, getEndpoints(), injectTrace);

  stats.total++;
  stats.totalDurationMs += rec.durationMs;
  recentTimestamps.push(Date.now());

  if (rec.status >= 200 && rec.status < 300) {
    stats.ok2xx++;
  } else if (rec.status >= 400 && rec.status < 500) {
    stats.clientError4xx++;
  } else if (rec.status >= 500) {
    stats.serverError5xx++;
  } else {
    stats.otherError++;
  }

  updateStatsUI();
  appendLog(rec);
}

function trafficLoop() {
  if (!isRunning) return;
  triggerSingleRequest().finally(() => {
    if (isRunning) {
      timerId = setTimeout(trafficLoop, intervalMs);
    }
  });
}

function startTraffic() {
  if (isRunning) return;
  isRunning = true;
  pulseDot.className = 'status-indicator-dot running';
  toggleStatus.innerHTML = 'Traffic Generator: <strong>RUNNING</strong>';
  trafficLoop();
}

function stopTraffic() {
  isRunning = false;
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
  pulseDot.className = 'status-indicator-dot paused';
  toggleStatus.innerHTML = 'Traffic Generator: <strong>PAUSED</strong>';
  updateStatsUI();
}

// Event Listeners
scenarioSelect.addEventListener('change', (e) => {
  updateScenarioDetails((e.target as HTMLSelectElement).value);
});

document.querySelectorAll<HTMLButtonElement>('.preset-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    const sc = btn.dataset.scenario;
    if (sc) updateScenarioDetails(sc);
  });
});

trafficToggle.addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) {
    startTraffic();
  } else {
    stopTraffic();
  }
});

intervalSlider.addEventListener('input', (e) => {
  updateIntervalBadge(parseInt((e.target as HTMLInputElement).value, 10));
});

traceContextToggle.addEventListener('change', (e) => {
  injectTrace = (e.target as HTMLInputElement).checked;
});

sendSingleBtn.addEventListener('click', () => {
  triggerSingleRequest();
});

resetStatsBtn.addEventListener('click', () => {
  stats.total = 0;
  stats.ok2xx = 0;
  stats.clientError4xx = 0;
  stats.serverError5xx = 0;
  stats.otherError = 0;
  stats.totalDurationMs = 0;
  recentTimestamps.length = 0;
  updateStatsUI();
});

clearLogsBtn.addEventListener('click', () => {
  allRecords.length = 0;
  streamCounter.textContent = '0 logged';
  logContainer.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🚀</div>
      <div class="empty-title">Stream Cleared</div>
      <div class="empty-sub">Enable <strong>Traffic Generator</strong> above or click <strong>Fire Single Request</strong> to start inspecting transactions in real time.</div>
    </div>
  `;
});

filterPills.querySelectorAll<HTMLButtonElement>('.filter-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterPills.querySelectorAll('.filter-pill').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = (btn.dataset.filter || 'all') as StatusFilter;
    renderLogs();
  });
});

// Periodic RPS update even when idle
setInterval(updateStatsUI, 1000);

// Initialize
initScenarios();
updateStatsUI();
