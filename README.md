# zcode-gateway

Local OpenAI/Anthropic-compatible gateway in front of a **ZCode (z.ai) plan**.
One process, zero npm dependencies, its own OAuth login.

```
any agent  ->  http://127.0.0.1:8790/v1   (OpenAI)      ->  zcode.z.ai
           ->  http://127.0.0.1:8790      (Anthropic)
```

The gateway has no models of its own. It signs every request with the plan JWT
on this machine and forwards it, so the plan's limits still apply.

It speaks two protocols, so **any agent that supports a custom OpenAI base URL
or a custom Anthropic base URL works with it** — no per-agent integration.

| Agent speaks | Base URL |
|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8790/v1` |
| Anthropic Messages | `http://127.0.0.1:8790` |

---

## Quick start

Needs Node 22+.

```bash
# 1. sign in once (opens a browser, approve, done)
./run.sh login

# 2. start the gateway
./run.sh
# Ctrl+C to stop

# 3. point an agent at it
export OPENAI_BASE_URL=http://127.0.0.1:8790/v1
```

Check it:

```bash
./run.sh status
./run.sh models

curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"say hi"}]}'
```

---

## Wiring it into agents

**opencode / any OpenAI-compatible client**

```json
{
  "provider": {
    "zcode": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8790/v1", "apiKey": "local" },
      "models": { "glm-5.3": {}, "glm-5.3-flash": {} }
    }
  }
}
```

**Claude Code / any Anthropic-compatible client**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
export ANTHROPIC_AUTH_TOKEN=local
```

Any non-empty key works — the gateway ignores it unless `ZCODE_GATEWAY_KEY` is set.

---

## Running on Android (Termux)

The gateway is pure Node with no native modules, so it runs on a phone as-is.

```bash
pkg install -y nodejs
cd ~/zcode-gateway
./run.sh login      # URL is printed; open it manually, xdg-open is absent
./run.sh serve
termux-wake-lock    # keep Android from killing the process
```

Expose it to another device on the same network:

```bash
ZCODE_GATEWAY_HOST=0.0.0.0 ZCODE_GATEWAY_KEY=<key> ./run.sh serve
# client: http://<phone-lan-ip>:8790/v1   apiKey: <key>
```

Notes: no HTTPS, so never expose it beyond a trusted network or a WireGuard /
Tailscale tunnel; battery optimisation must be disabled for Termux; auto-start
needs the `Termux:Boot` add-on and a script in `~/.termux/boot/`.

---

## How it works

### Login

Server-mediated, no localhost callback:

```
POST https://zcode.z.ai/api/v1/oauth/cli/init     Authorization: Bearer <random 32B hex>
  -> { flow_id, authorize_url, expires_at, poll_interval_sec }

open authorize_url (+ redirect_uri interstitial) in a browser -> approve there

GET  https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}   Authorization: Bearer <same token>
  -> { status: "ready", token: <plan JWT>, zai: { access_token }, user: { user_id } }
```

The JWT lands in `data/credentials.json` (mode `0600`). The payload carries
`iat` but no `exp` — upstream does not reject by age, so re-login is only
needed after an actual `401`.

Nothing in `~/.zcode/` is read for auth, and the desktop app's encrypted
credential store is never touched.

### Request shape

Every upstream call carries the desktop client's identity headers:

```
authorization: Bearer <plan JWT>
anthropic-version: 2023-06-01
User-Agent: ZCode/3.18.2 ai-sdk/anthropic/3.0.81
X-Title: Z Code@ZCode
HTTP-Referer: https://zcode.z.ai
X-Release-Channel / X-Client-Language / X-Client-Timezone
X-ZCode-Agent: glm / X-Platform / X-Os-Category / X-Os-Version
x-request-id / x-zcode-trace-id / x-zcode-session-type: main
```

`x-session-id` and `x-query-id` are omitted — this is the start-plan plane,
which is never signed.

The body is rewritten the way the client rewrites it:

1. `system` is replaced with the 3-block ZCode identity shape (prefix / stable
   block / caller's own system text). **The gateway rejects requests without
   it** (error `3012`), so it is not optional.
2. Cache breakpoints are normalised: stale `cache_control` is stripped from
   non-system messages, the last block of the last message is marked ephemeral.
3. `metadata.user_id` is set to `{"device_id":...,"account_uuid":"","session_id":...}`.

`device_id` comes from `~/.zcode/v2/telemetry-state.json` when a desktop
install exists, otherwise from `data/state.json` (generated once).

### Concurrency

A single-flight gate (`ZCODE_MAX_CONCURRENCY`) keeps bursts from tripping
upstream limits. Queued requests wait, they are not rejected. `run.sh` starts it
at `1`, because the start plan allows one in-flight turn per account and holds
the slot for a moment after the stream closes; raise it only if the plan allows.

The slot is held for the whole stream, not just until the response headers
arrive — releasing early lets the next queued turn collide upstream.

If upstream still answers `user concurrency limit exceeded` (a competing client
such as the desktop app on the same account), the gateway retries with backoff
before surfacing the error.

---

## Models

The plan serves exactly two, verified against every id the client config
publishes:

| id | context | max output | notes |
|---|---|---|---|
| `glm-5.3` | 1M | 128k | flagships, no vision |
| `glm-5.3-flash` | 1M | 128k | faster, vision-capable |

Older ids (`glm-5.2`, `glm-5-turbo`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.6`,
`glm-4.6v`, `glm-4.5-air`) exist in the client's static catalog but this plan
answers `model not allowed` for them, so they are not advertised here. They are
also not rejected locally — an unknown id still reaches upstream, which decides.

Both expose `output_config.effort` (`low` / `high` / `max`, client default `max`);
the gateway passes it through untouched.

---

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (translated to Anthropic upstream) |
| `POST /v1/messages` | Anthropic Messages (native passthrough) |
| `GET /v1/models` | Model catalog, both shapes in one payload |
| `GET /health` | Status, queue depth, credential freshness |

Streaming works on both routes (`"stream": true`).

---

## Configuration

All optional, all via environment.

| Variable | Default | Meaning |
|---|---|---|
| `ZCODE_GATEWAY_PORT` | `8790` | listen port |
| `ZCODE_GATEWAY_HOST` | `127.0.0.1` | bind address |
| `ZCODE_GATEWAY_KEY` | *(empty)* | require this bearer key from clients |
| `ZCODE_DEFAULT_MODEL` | `glm-5.3` | model used when a request omits one |
| `ZCODE_MAX_CONCURRENCY` | `1` (`run.sh`) | simultaneous upstream requests |
| `ZCODE_UPSTREAM_URL` | start-plan endpoint | override the upstream |
| `ZCODE_APP_VERSION` | `3.18.2` | value sent in `User-Agent` / `X-ZCode-App-Version` |
| `ZCODE_INJECT_SYSTEM` | `1` | set `0` to skip the identity system blocks (probing only) |

---

## Files

```
src/config.js          config, model catalog, device id
src/zcode.js           credentials, upstream headers, body transform, queue
src/anthropic.js       OpenAI <-> Anthropic translation + SSE
src/server.js          HTTP routes
src/login.js           OAuth init/poll
src/zcode_system.json  the identity system blocks upstream requires
run.sh                 serve / login / status / models
data/                  credentials + device state (gitignored, 0600)
```

---

## Limits and caveats

- **start-plan only.** This targets `https://zcode.z.ai/api/v1/zcode-plan/anthropic`.
  The coding-plan plane (`api.z.ai/api/anthropic`, dual `x-api-key` + `Bearer`,
  V4 request signing with PoW) is not implemented.
- **The identity system blocks are mandatory.** Upstream inspects the `system`
  field and returns `3012` without them. They are prepended on every request,
  which means every client inherits that preamble; the client's own system
  prompt still rides along in block 3.
- **Model ids are passed through.** An id outside the advertised pair still
  reaches upstream, which is free to answer `model not allowed`.
- **Captcha is not implemented.** It is currently disabled for model requests
  upstream (`skip_model_request`), so it is not needed.
- **No token refresh.** Re-run `./run.sh login` when upstream answers `401`.
- Captured traffic and plan quota behave exactly as they do in the desktop app.
  This is a bridge, not a bypass.
