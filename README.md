# Token Bucket Rate Limiter Service

A standalone HTTP service that makes allow or deny decisions for client keys. It uses Redis for durable configuration and limiter state, Redis Lua scripts for atomic decisions, and a small same-origin dashboard for client configuration and live activity.

## Architecture

- **API:** Node.js 20 or newer with Express. `POST /v1/limit` accepts a client key and returns an `ALLOW` or `DENY` decision.
- **State store:** Redis stores client configuration, token bucket state, sliding-window event logs, and short-lived metrics. The service does not keep limiter state in process memory.
- **Concurrency control:** One Lua script reads configuration, updates the selected algorithm's state, decides the request, and increments metrics atomically. Requests for the same key are serialized by Redis, so concurrent requests cannot spend the same token or event slot twice.
- **Dashboard:** Static HTML, CSS, and JavaScript served by the API on the same origin. It polls the metrics endpoint once per second and requires the admin API key for management operations.
- **Persistence:** The included Compose configuration runs Redis with append-only persistence and a named volume. The volume survives container recreation and service restarts.

Bucket state and sliding-window event logs do not expire automatically: a client's bucket must not refill early after a configuration change, and an extended sliding window must not lose events. The sliding-window script prunes old events during each decision. Metrics expire after 120 seconds.

The example Compose setup is intended for a single Redis instance. Redis Cluster requires keys used in each Lua script to share a hash slot; this implementation does not currently add cluster hash tags. For a production deployment, use a managed Redis deployment with persistence and backups enabled, set a strong admin key through a secret manager, terminate TLS at a trusted proxy, and restrict network access to Redis and the admin endpoints.

## Run with Docker Compose

Create a local environment file and set a long random admin key:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace `ADMIN_API_KEY`. Then start the API and Redis:

```powershell
docker compose up --build -d
```

The service is available at `http://localhost:3000`. The dashboard is at the root URL and the health check is `GET /health`.

Stop the services while retaining persisted Redis data:

```powershell
docker compose down
```

To delete the Redis volume and all persisted configuration and limiter state, run `docker compose down -v`.

## Run locally with a separate Redis

Install Node.js 20 or newer and Redis 7 or newer. Start Redis with persistence enabled, for example:

```sh
redis-server --appendonly yes --appendfsync everysec
```

In another terminal, install dependencies and configure the environment:

```sh
npm install
```

Set `REDIS_URL`, `PORT`, and `ADMIN_API_KEY`. `ADMIN_API_KEY` must contain at least 24 characters. On PowerShell:

```powershell
$env:REDIS_URL = "redis://localhost:6379"
$env:PORT = "3000"
$env:ADMIN_API_KEY = "replace-with-a-long-random-secret-value"
npm start
```

Alternatively, copy `.env.example` to `.env`, edit it, and run `npm start`. The development command `npm run dev` restarts the Node process when source files change.

## API

All responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. The reset header is a Unix timestamp in seconds. For token buckets, it marks when the bucket will be full; for sliding windows, it is the end of the current window. A denied limit check also includes `Retry-After` in seconds and `retryAfterMs` in the JSON body when a retry time is known.

### Check a client key

`POST /v1/limit`

Request:

```json
{
  "clientKey": "customer-123"
}
```

Example response:

```json
{
  "status": "ALLOW",
  "clientKey": "customer-123",
  "algorithm": "token-bucket",
  "limit": 20,
  "remaining": 19,
  "resetAt": 1790000000
}
```

The endpoint returns HTTP 200 for both `ALLOW` and `DENY` decisions. An unknown client returns HTTP 404 with `status: "DENY"`; configure clients before sending traffic. Malformed client keys return HTTP 400. If Redis is unavailable, the service fails closed with HTTP 503 and `status: "DENY"`.

Example:

```sh
curl -i http://localhost:3000/v1/limit \
  -H "Content-Type: application/json" \
  -d '{"clientKey":"customer-123"}'
```

### Create or update a client

`PUT /v1/admin/clients/{clientKey}`

Requires the `X-Admin-Key` header. The path parameter is the client key. Updating an existing key changes its configuration without deleting its stored bucket or event history; the next decision applies the new settings.

Request:

```json
{
  "algorithm": "token-bucket",
  "requestsPerSecond": 10,
  "burstSize": 20
}
```

`algorithm` must be `token-bucket` or `sliding-window`. `requestsPerSecond` must be a finite number greater than zero and at most 1,000,000. `burstSize` must be an integer from 1 through 1,000,000. Client keys may contain at most 200 characters.

Example:

```sh
curl -i -X PUT http://localhost:3000/v1/admin/clients/customer-123 \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: replace-with-your-admin-key" \
  -d '{"algorithm":"token-bucket","requestsPerSecond":10,"burstSize":20}'
```

### List configured clients

`GET /v1/admin/clients`

Requires `X-Admin-Key`. Returns a `clients` array with each client's algorithm, rate, burst size, and last configuration update time.

### Read live metrics

`GET /v1/admin/metrics`

Requires `X-Admin-Key`. Returns per-client request and deny counts from the previous 10 seconds, plus rates calculated as count divided by 10. Metrics are stored in Redis with a 120-second expiry. The dashboard calls this endpoint every second.

### Health check

`GET /health` returns HTTP 200 when Redis responds to `PING`; otherwise it returns HTTP 503.

## Algorithm behavior

### Token Bucket

`burstSize` is the bucket capacity and initial token count. Tokens refill continuously at `requestsPerSecond`. A request consumes one token when available. When empty, a request is denied until a token refills. The Redis Lua script performs refill, consume, state persistence, and metric updates as a single atomic operation.

### Sliding Window

The service stores accepted request timestamps in a Redis sorted set. The maximum count in the rolling window is `burstSize`, and the rolling-window duration is `burstSize / requestsPerSecond` seconds (rounded up to the next millisecond, with a minimum of one millisecond). This preserves the configured average rate while allowing a burst up to the selected size. Each decision prunes expired timestamps and checks/adds the new event in the same Lua script.

Both modes use the same rate and burst settings but interpret them according to their algorithm. To change a client between modes, update its configuration through the admin endpoint.

## Dashboard

Open `http://localhost:3000` in a browser. Enter the configured admin key and select **Connect**. The activity table shows request and deny rates per client, using a 10-second measurement window. Use the configuration form to add or update a client. The page does not save the admin key in local storage.

## Load test and concurrency check

The custom Node.js script sends a burst of at least 500 simultaneous HTTP requests to one client key for each algorithm. It configures each test client with a deliberately slow refill rate and a fixed burst size, then verifies that exactly that many requests are allowed and every other request is denied. It also reports observed requests per second and fails if the configured minimum throughput is not reached. The default minimum is 500 requests per second.

Start the service first. Then, in a separate terminal, set `ADMIN_API_KEY` to the same key used by the service and run:

```sh
npm run load-test
```

Optional environment variables are `BASE_URL` (default `http://localhost:3000`), `CONCURRENCY` (default `500`, minimum `500`), `BURST_SIZE` (default `50`), and `MIN_RPS` (default `500`). For example, in PowerShell:

```powershell
$env:ADMIN_API_KEY = "replace-with-your-long-random-secret-value"
$env:CONCURRENCY = "1000"
$env:BURST_SIZE = "100"
$env:MIN_RPS = "500"
npm run load-test
```

The script creates uniquely named test clients and leaves their configuration and short-lived state in Redis. Use a disposable Redis database when running repeated load tests against a production-like deployment. The test measures client-observed HTTP throughput; actual throughput depends on the host, Redis placement, and network path.

## Operational notes

- The rate endpoint is intentionally unauthenticated because it is called by downstream applications. Protect it with network policy, TLS, and upstream authentication as required by your deployment.
- Admin operations require a secret key and use timing-safe comparison. Keep the admin key private; requests should use HTTPS outside local development.
- When Redis is unavailable the API fails closed. This avoids accidentally allowing traffic without applying limits.
- Redis AOF with `appendfsync everysec` may lose the most recent second of writes if the host fails abruptly. Choose persistence and backup settings to match your recovery requirements.
- Configure `TRUST_PROXY=true` only when the service is behind a trusted reverse proxy. The service currently keys limits explicitly by the supplied `clientKey`; it does not infer identity from IP addresses.
