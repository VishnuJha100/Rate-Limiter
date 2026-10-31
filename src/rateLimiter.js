const { randomUUID } = require('node:crypto');

const DECISION_SCRIPT = `
local algorithm = redis.call('HGET', KEYS[1], 'algorithm')
if not algorithm then return {'UNCONFIGURED'} end
local rate = tonumber(redis.call('HGET', KEYS[1], 'requestsPerSecond'))
local burst = tonumber(redis.call('HGET', KEYS[1], 'burstSize'))
if not rate or not burst then return {'INVALID_CONFIG'} end
local now = tonumber(ARGV[1])
local id = ARGV[2]
local metricKey = KEYS[4]
local allowed = false
local remaining = 0
local resetAt = now
local retryMs = 0

if algorithm == 'token-bucket' then
  local oldTokens = tonumber(redis.call('HGET', KEYS[2], 'tokens'))
  local oldTime = tonumber(redis.call('HGET', KEYS[2], 'updatedAt'))
  local tokens = burst
  if oldTokens and oldTime then
    tokens = math.min(burst, oldTokens + math.max(0, now - oldTime) * rate / 1000)
  end
  if tokens >= 1 then
    allowed = true
    tokens = tokens - 1
  else
    retryMs = math.ceil((1 - tokens) / rate * 1000)
  end
  redis.call('HSET', KEYS[2], 'tokens', tokens, 'updatedAt', now)
  remaining = math.floor(tokens)
  resetAt = now + math.ceil((burst - tokens) / rate * 1000)
elseif algorithm == 'sliding-window' then
  local windowMs = math.max(1, math.ceil(burst / rate * 1000))
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - windowMs)
  local count = redis.call('ZCARD', KEYS[3])
  if count < burst then
    allowed = true
    redis.call('ZADD', KEYS[3], now, now .. ':' .. id)
    count = count + 1
  else
    local oldest = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
    if oldest[2] then retryMs = math.max(1, tonumber(oldest[2]) + windowMs - now) end
  end
  remaining = math.max(0, burst - count)
  resetAt = now + windowMs
else
  return {'INVALID_CONFIG'}
end

redis.call('HINCRBY', metricKey, 'total', 1)
if not allowed then redis.call('HINCRBY', metricKey, 'denied', 1) end
redis.call('EXPIRE', metricKey, 120)
return {allowed and 'ALLOW' or 'DENY', tostring(remaining), tostring(resetAt), tostring(retryMs), algorithm, tostring(burst)}
`;

function encodeKey(clientKey) {
  return Buffer.from(clientKey, 'utf8').toString('base64url');
}

function keysFor(clientKey, second) {
  const encoded = encodeKey(clientKey);
  return {
    config: `rl:config:${encoded}`,
    bucket: `rl:bucket:${encoded}`,
    events: `rl:events:${encoded}`,
    metrics: `rl:metrics:${encoded}:${second}`,
    encoded,
  };
}

async function checkLimit(redis, clientKey) {
  const now = Date.now();
  const keys = keysFor(clientKey, Math.floor(now / 1000));
  const result = await redis.eval(DECISION_SCRIPT, {
    keys: [keys.config, keys.bucket, keys.events, keys.metrics],
    arguments: [String(now), randomUUID()],
  });
  return { result, keys };
}

module.exports = { checkLimit, encodeKey, keysFor };
