import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";

const EPHEMERAL = { type: "ephemeral" };

const systemAsset = JSON.parse(
  fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "zcode_system.json"), "utf8"),
);

export class GatewayError extends Error {
  constructor(status, message, code = "gateway_error", extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

let credCache = { value: null, mtimeMs: 0 };

export async function loadCredentials() {
  let stat;
  try {
    stat = await fsp.stat(paths.credentials);
  } catch {
    throw new GatewayError(
      503,
      `No ZCode login found at ${paths.credentials}. Start the gateway with "./run.sh login" first.`,
      "zcode_not_signed_in",
    );
  }
  if (credCache.value && credCache.mtimeMs === stat.mtimeMs) return credCache.value;

  const raw = await fsp.readFile(paths.credentials, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed?.jwt !== "string" || parsed.jwt.length === 0) {
    throw new GatewayError(
      503,
      "Stored credentials have no start-plan JWT. Re-run \"./run.sh login\".",
      "zcode_jwt_missing",
    );
  }
  credCache = { value: parsed, mtimeMs: stat.mtimeMs };
  return parsed;
}

export async function saveCredentials(payload) {
  await fsp.mkdir(paths.data, { recursive: true });
  const body = JSON.stringify(payload, null, 2);
  await fsp.writeFile(paths.credentials, body, { mode: 0o600 });
  await fsp.chmod(paths.credentials, 0o600);
  credCache = { value: payload, mtimeMs: 0 };
}

export async function credentialStatus() {
  try {
    const cred = await loadCredentials();
    const info = inspectJwt(cred.jwt);
    return {
      signed_in: true,
      saved_at: cred.savedAt ?? null,
      user_id: cred.userId ?? null,
      jwt_issued_at: info?.iat ? new Date(info.iat * 1000).toISOString() : null,
      jwt_age_hours: info ? Math.round(info.ageHours * 10) / 10 : null,
    };
  } catch (err) {
    return { signed_in: false, error: err.message };
  }
}

/** Decode the plan JWT payload. The token carries `iat` but no `exp`. */
export function inspectJwt(jwt) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
    if (typeof payload.iat !== "number") return null;
    return { iat: payload.iat, ageHours: Math.max(0, (Date.now() / 1000 - payload.iat) / 3600), userId: payload.user_id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upstream headers
// ---------------------------------------------------------------------------

function identityHeaders() {
  return {
    "HTTP-Referer": config.refererOrigin,
    "User-Agent": `ZCode/${config.appVersion} ${config.sdkUserAgent}`,
    "X-ZCode-App-Version": config.appVersion,
    "X-Title": `Z Code@${config.sourceTitle}`,
    "X-Release-Channel": config.releaseChannel,
    "X-Client-Language": config.clientLanguage,
    "X-Client-Timezone": config.clientTimezone,
    "X-ZCode-Agent": "glm",
    "X-Platform": config.platform,
    "X-Os-Category": config.osCategory,
    "X-Os-Version": config.osVersion,
  };
}

// start-plan is never signed, so x-session-id / x-query-id are omitted —
// exactly what the desktop client sends on this plane.
function traceHeaders(sessionId) {
  const headers = {
    "x-request-id": randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": randomUUID(),
  };
  if (sessionId) headers["x-session-id"] = sessionId;
  return headers;
}

function stripSessionPrefix(value) {
  return String(value).replace(/^(sess_|subagent_agent_)/, "") || "";
}

export function buildMetadataUserId(sessionId) {
  return JSON.stringify({
    device_id: config.deviceMid,
    account_uuid: "",
    session_id: sessionId ? stripSessionPrefix(sessionId) : "",
  });
}

function buildHeaders(jwt, sessionId) {
  return {
    "content-type": "application/json",
    // Keep the wire uncompressed so SSE frames can be parsed without a
    // decompression stage.
    "accept-encoding": "identity",
    accept: "text/event-stream, application/json",
    ...identityHeaders(),
    ...traceHeaders(sessionId),
    authorization: `Bearer ${jwt}`,
    "anthropic-version": "2023-06-01",
  };
}

// ---------------------------------------------------------------------------
// Body transformation (mirrors the official client's request assembly)
// ---------------------------------------------------------------------------

function customSystemText(system) {
  if (system == null) return undefined;
  if (typeof system === "string") {
    const text = system.trim();
    return text ? text : undefined;
  }
  if (!Array.isArray(system)) return undefined;
  const parts = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) parts.push(item);
    } else if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function buildSystemBlocks(existingSystem) {
  const custom = customSystemText(existingSystem);
  const stable = systemAsset.stableSections.join("\n\n");
  const dynamic = custom === undefined ? "" : custom;
  return [
    { type: "text", text: systemAsset.cliPrefix },
    { type: "text", text: stable, cache_control: { ...EPHEMERAL } },
    { type: "text", text: dynamic === "" ? "" : `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ];
}

/**
 * Apply the mutations the real client performs before dispatch:
 *   1. replace `system` with the 3-block ZCode identity shape
 *   2. rewrite cache breakpoints (clear stale, mark last non-system block)
 *   3. inject metadata.user_id
 * Returns the serialized body. Malformed input passes through untouched.
 */
export function transformBody(rawBody, sessionId) {
  if (typeof rawBody !== "string" || rawBody.length === 0) return rawBody;

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed !== "object" || parsed === null) return rawBody;

  if (config.injectSystem) {
    parsed.system = buildSystemBlocks(parsed.system);
  }

  const messages = parsed.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object" || msg.role === "system") continue;
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === "object" && "cache_control" in block) delete block.cache_control;
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object" || msg.role === "system") continue;
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content, cache_control: { ...EPHEMERAL } }];
        break;
      }
      if (Array.isArray(msg.content) && msg.content.length > 0) {
        const last = msg.content[msg.content.length - 1];
        if (last && typeof last === "object" && !last.cache_control) last.cache_control = { ...EPHEMERAL };
        break;
      }
      break;
    }
  }

  const metadata = parsed.metadata && typeof parsed.metadata === "object" ? { ...parsed.metadata } : {};
  metadata.user_id = buildMetadataUserId(sessionId);
  parsed.metadata = metadata;

  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

const queue = { active: 0, waiting: [], peak: 0, served: 0 };

export function queueStats() {
  return { active: queue.active, waiting: queue.waiting.length, peak: queue.peak, served: queue.served, limit: config.maxConcurrency };
}

function makeReleaser() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    queue.served += 1;
    queue.active = Math.max(0, queue.active - 1);
    const next = queue.waiting.shift();
    if (next) next();
  };
}

export function acquireSlot() {
  if (queue.active < config.maxConcurrency) {
    queue.active += 1;
    queue.peak = Math.max(queue.peak, queue.active);
    return Promise.resolve(makeReleaser());
  }
  return new Promise((resolve) => {
    queue.waiting.push(() => {
      queue.active += 1;
      queue.peak = Math.max(queue.peak, queue.active);
      resolve(makeReleaser());
    });
  });
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

export async function callUpstream(rawBody, { sessionId, signal } = {}) {
  const cred = await loadCredentials();
  const body = transformBody(rawBody, sessionId);

  const send = () =>
    fetch(config.upstreamUrl, {
      method: "POST",
      headers: buildHeaders(cred.jwt, sessionId),
      body,
      signal,
    });

  // Retries: connect failures, gateway 5xx, and ZCode's "user concurrency limit
  // exceeded" (start-plan allows one in-flight turn per account, and upstream
  // keeps the slot for a moment after our stream closes). Never retry 401 — it
  // carries a verdict about the JWT.
  const MAX_ATTEMPTS = 4;
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await send();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || signal?.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      continue;
    }

    const retryableStatus = response.status >= 500 && response.status !== 501;
    const maybeBusy = response.status >= 400 && response.status < 500 && response.status !== 401;

    if (!retryableStatus && !maybeBusy) break;
    if (attempt >= MAX_ATTEMPTS || signal?.aborted) break;

    const text = await response.text().catch(() => "");
    const busy = /concurrency limit/i.test(text);
    if (!retryableStatus && !busy) {
      response = new Response(text, { status: response.status, headers: response.headers });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, busy ? 1200 * attempt : 400 * attempt));
  }

  if (response.status === 401) {
    throw new GatewayError(
      401,
      "ZCode rejected the start-plan JWT. Run \"./run.sh login\" to sign in again.",
      "zcode_jwt_rejected",
    );
  }
  return response;
}

export async function describeUpstreamError(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    /* ignore */
  }
  let detail = text.slice(0, 800);
  try {
    const parsed = JSON.parse(text);
    const candidate =
      parsed?.error?.message ?? parsed?.msg ?? parsed?.message ?? parsed?.error?.type ?? parsed?.error;
    if (typeof candidate === "string" && candidate.length > 0) detail = candidate;
  } catch {
    /* not JSON */
  }
  return { status: response.status, detail: detail || response.statusText || "upstream error" };
}

export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id",
    "access-control-max-age": "86400",
  };
}
