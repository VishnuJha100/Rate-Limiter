const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminKey = process.env.ADMIN_API_KEY;
const concurrency = Number(process.env.CONCURRENCY || 500);
const burstSize = Number(process.env.BURST_SIZE || 50);
const minRps = Number(process.env.MIN_RPS || 500);

if (!adminKey) {
  console.error('Set ADMIN_API_KEY to the same value used by the service.');
  process.exit(1);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function configure(clientKey, algorithm) {
  const { response, body } = await request(`${baseUrl}/v1/admin/clients/${encodeURIComponent(clientKey)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ algorithm, requestsPerSecond: 0.000001, burstSize }),
  });
  if (!response.ok) throw new Error(`Configuration failed (${response.status}): ${JSON.stringify(body)}`);
}

async function runBurst(algorithm) {
  const clientKey = `load-test-${algorithm}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await configure(clientKey, algorithm);
  const start = performance.now();
  const responses = await Promise.all(Array.from({ length: concurrency }, () => request(`${baseUrl}/v1/limit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey }),
  })));
  const elapsedSeconds = (performance.now() - start) / 1000;
  const allowed = responses.filter(({ body }) => body.status === 'ALLOW').length;
  const denied = responses.filter(({ body }) => body.status === 'DENY').length;
  const badStatus = responses.filter(({ response }) => response.status !== 200).length;
  const requestsPerSecond = concurrency / elapsedSeconds;
  console.log(`${algorithm}: ${concurrency} concurrent requests in ${elapsedSeconds.toFixed(3)}s (${requestsPerSecond.toFixed(0)} requests/s), ${allowed} allowed, ${denied} denied.`);

  if (badStatus !== 0 || allowed !== burstSize || denied !== concurrency - burstSize) {
    throw new Error(`${algorithm} correctness check failed: expected exactly ${burstSize} allows and ${concurrency - burstSize} denies.`);
  }
  if (requestsPerSecond < minRps) {
    throw new Error(`Observed ${requestsPerSecond.toFixed(0)} requests/s; minimum configured rate is ${minRps}.`);
  }
}

async function main() {
  if (!Number.isInteger(concurrency) || concurrency < 500) throw new Error('CONCURRENCY must be an integer of at least 500.');
  if (!Number.isInteger(burstSize) || burstSize < 1 || burstSize >= concurrency) throw new Error('BURST_SIZE must be an integer greater than zero and less than CONCURRENCY.');
  if (!Number.isFinite(minRps) || minRps <= 0) throw new Error('MIN_RPS must be a positive number.');
  const health = await fetch(`${baseUrl}/health`);
  if (!health.ok) throw new Error(`Service health check failed with HTTP ${health.status}.`);
  await runBurst('token-bucket');
  await runBurst('sliding-window');
  console.log('Concurrency checks passed for both algorithms.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
