require('dotenv').config();

const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { createClient } = require('redis');
const { checkLimit, encodeKey } = require('./rateLimiter');

const app = express();
const port = Number(process.env.PORT || 3000);
const adminApiKey = process.env.ADMIN_API_KEY;
if (!adminApiKey || adminApiKey.length < 24) {
  throw new Error('ADMIN_API_KEY must be set to a secret of at least 24 characters.');
}

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (error) => console.error('Redis client error:', error.message));

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use((req, res, next) => {
  res.set({
    'X-RateLimit-Limit': '0',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000)),
  });
  next();
});
app.use(express.json({ limit: '16kb' }));

function adminOnly(req, res, next) {
  const provided = req.get('x-admin-key');
  const matches = provided && Buffer.byteLength(provided) === Buffer.byteLength(adminApiKey)
    ? timingSafeEqual(Buffer.from(provided), Buffer.from(adminApiKey))
    : false;
  if (!matches) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function validateConfig(body) {
  const { clientKey, algorithm, requestsPerSecond, burstSize } = body || {};
  if (typeof clientKey !== 'string' || clientKey.trim().length === 0 || clientKey.length > 200) {
    return 'clientKey must be a non-empty string of at most 200 characters.';
  }
  if (!['token-bucket', 'sliding-window'].includes(algorithm)) {
    return 'algorithm must be token-bucket or sliding-window.';
  }
  if (typeof requestsPerSecond !== 'number' || !Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 1000000) {
    return 'requestsPerSecond must be a number greater than 0 and at most 1000000.';
  }
  if (!Number.isInteger(burstSize) || burstSize < 1 || burstSize > 1000000) {
    return 'burstSize must be an integer between 1 and 1000000.';
  }
  return null;
}

app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', redis: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable', redis: 'unavailable' });
  }
});

app.post('/v1/limit', async (req, res) => {
  const { clientKey } = req.body || {};
  if (typeof clientKey !== 'string' || clientKey.trim().length === 0 || clientKey.length > 200) {
    return res.status(400).json({ status: 'DENY', error: 'clientKey must be a non-empty string of at most 200 characters.' });
  }
  try {
    const { result } = await checkLimit(redis, clientKey);
    if (result[0] === 'UNCONFIGURED') {
      res.set({ 'X-RateLimit-Limit': '0', 'X-RateLimit-Remaining': '0' });
      return res.status(404).json({ status: 'DENY', error: 'Client is not configured.' });
    }
    if (result[0] === 'INVALID_CONFIG') return res.status(500).json({ status: 'DENY', error: 'Stored client configuration is invalid.' });

    const [status, remaining, resetAt, retryMs, algorithm, limit] = result;
    res.set({
      'X-RateLimit-Limit': limit,
      'X-RateLimit-Remaining': remaining,
      'X-RateLimit-Reset': String(Math.ceil(Number(resetAt) / 1000)),
    });
    if (status === 'DENY' && Number(retryMs) > 0) res.set('Retry-After', String(Math.max(1, Math.ceil(Number(retryMs) / 1000))));
    return res.status(200).json({
      status,
      clientKey,
      algorithm,
      limit: Number(limit),
      remaining: Number(remaining),
      resetAt: Math.ceil(Number(resetAt) / 1000),
      ...(status === 'DENY' ? { retryAfterMs: Number(retryMs) } : {}),
    });
  } catch (error) {
    console.error('Rate limit decision failed:', error.message);
    return res.status(503).json({ status: 'DENY', error: 'Rate limiter storage is unavailable.' });
  }
});

app.put('/v1/admin/clients/:clientKey', adminOnly, async (req, res) => {
  const body = { ...req.body, clientKey: req.params.clientKey };
  const validationError = validateConfig(body);
  if (validationError) return res.status(400).json({ error: validationError });
  const { clientKey, algorithm, requestsPerSecond, burstSize } = body;
  const encoded = encodeKey(clientKey);
  try {
    await redis.multi()
      .hSet(`rl:config:${encoded}`, {
        clientKey,
        algorithm,
        requestsPerSecond: String(requestsPerSecond),
        burstSize: String(burstSize),
        updatedAt: new Date().toISOString(),
      })
      .sAdd('rl:clients', encoded)
      .exec();
    return res.status(200).json({ clientKey, algorithm, requestsPerSecond, burstSize, updated: true });
  } catch (error) {
    console.error('Client configuration update failed:', error.message);
    return res.status(503).json({ error: 'Rate limiter storage is unavailable.' });
  }
});

app.get('/v1/admin/clients', adminOnly, async (req, res) => {
  try {
    const ids = await redis.sMembers('rl:clients');
    const rows = await Promise.all(ids.map(async (id) => {
      const config = await redis.hGetAll(`rl:config:${id}`);
      if (!config.clientKey) return null;
      return {
        clientKey: config.clientKey,
        algorithm: config.algorithm,
        requestsPerSecond: Number(config.requestsPerSecond),
        burstSize: Number(config.burstSize),
        updatedAt: config.updatedAt,
      };
    }));
    res.json({ clients: rows.filter(Boolean) });
  } catch (error) {
    console.error('Client list failed:', error.message);
    res.status(503).json({ error: 'Rate limiter storage is unavailable.' });
  }
});

app.get('/v1/admin/metrics', adminOnly, async (req, res) => {
  try {
    const nowSecond = Math.floor(Date.now() / 1000);
    const ids = await redis.sMembers('rl:clients');
    const metrics = await Promise.all(ids.map(async (id) => {
      const config = await redis.hGetAll(`rl:config:${id}`);
      if (!config.clientKey) return null;
      const snapshots = await Promise.all(Array.from({ length: 10 }, (_, offset) => redis.hGetAll(`rl:metrics:${id}:${nowSecond - offset}`)));
      let total = 0;
      let denied = 0;
      for (const snapshot of snapshots) {
        total += Number(snapshot.total || 0);
        denied += Number(snapshot.denied || 0);
      }
      return {
        clientKey: config.clientKey,
        algorithm: config.algorithm,
        requestsPerSecond: Number((total / 10).toFixed(2)),
        deniesPerSecond: Number((denied / 10).toFixed(2)),
        requestsLast10Seconds: total,
        deniesLast10Seconds: denied,
      };
    }));
    res.json({ windowSeconds: 10, clients: metrics.filter(Boolean) });
  } catch (error) {
    console.error('Metrics retrieval failed:', error.message);
    res.status(503).json({ error: 'Rate limiter storage is unavailable.' });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, req, res, next) => {
  console.error('Request error:', error.message);
  if (res.headersSent) return next(error);
  return res.status(400).json({ error: 'Invalid request.' });
});

async function start() {
  await redis.connect();
  app.listen(port, '0.0.0.0', () => console.log(`Rate limiter listening on port ${port}`));
}

start().catch((error) => {
  console.error('Service startup failed:', error.message);
  process.exit(1);
});
