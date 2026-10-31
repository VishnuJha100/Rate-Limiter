const accessForm = document.querySelector('#access-form');
const configForm = document.querySelector('#config-form');
const adminKeyInput = document.querySelector('#admin-key');
const connectionStatus = document.querySelector('#connection-status');
const configStatus = document.querySelector('#config-status');
const metricsBody = document.querySelector('#metrics-body');
const updatedAt = document.querySelector('#updated-at');
let adminKey = '';
let refreshTimer;

function setStatus(element, message, kind = '') {
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey, ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function renderMetrics(clients) {
  metricsBody.replaceChildren();
  if (clients.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No clients are configured.';
    row.append(cell);
    metricsBody.append(row);
    return;
  }
  for (const client of clients) {
    const row = document.createElement('tr');
    const values = [client.clientKey, client.algorithm, client.requestsPerSecond.toFixed(2), client.deniesPerSecond.toFixed(2), client.requestsLast10Seconds, client.deniesLast10Seconds];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 2) cell.className = 'allow-rate';
      if (index === 3 && client.deniesLast10Seconds > 0) cell.className = 'deny-rate';
      row.append(cell);
    });
    metricsBody.append(row);
  }
}

async function refreshMetrics() {
  if (!adminKey) return;
  try {
    const data = await adminFetch('/v1/admin/metrics');
    renderMetrics(data.clients);
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    setStatus(connectionStatus, error.message, 'error');
    clearInterval(refreshTimer);
  }
}

accessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminKey = adminKeyInput.value;
  try {
    await adminFetch('/v1/admin/clients');
    setStatus(connectionStatus, 'Connected. Metrics are updating.', 'success');
    clearInterval(refreshTimer);
    await refreshMetrics();
    refreshTimer = setInterval(refreshMetrics, 1000);
  } catch (error) {
    adminKey = '';
    setStatus(connectionStatus, error.message, 'error');
  }
});

configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!adminKey) {
    setStatus(configStatus, 'Connect with an admin key before saving a client.', 'error');
    return;
  }
  const values = Object.fromEntries(new FormData(configForm));
  const payload = {
    algorithm: values.algorithm,
    requestsPerSecond: Number(values.requestsPerSecond),
    burstSize: Number(values.burstSize),
  };
  try {
    await adminFetch(`/v1/admin/clients/${encodeURIComponent(values.clientKey)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    setStatus(configStatus, `Configuration saved for ${values.clientKey}.`, 'success');
    await refreshMetrics();
  } catch (error) {
    setStatus(configStatus, error.message, 'error');
  }
});
