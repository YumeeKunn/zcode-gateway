import http from "node:http";
import { config, modelIds, resolveModel } from "./config.js";
import {
  GatewayError,
  acquireSlot,
  callUpstream,
  corsHeaders,
  credentialStatus,
  describeUpstreamError,
  queueStats,
} from "./zcode.js";
import { anthropicToOpenAI, anthropicSseToOpenAiSse, openAIToAnthropic } from "./anthropic.js";

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function sendOpenAIError(res, status, message, code = null) {
  sendJson(res, status, {
    error: {
      message,
      type: code ?? "gateway_error",
      code: code ?? "gateway_error",
      param: null,
    },
  });
}

function sendAnthropicError(res, status, message, code = null) {
  sendJson(res, status, {
    type: "error",
    error: { type: code ?? "api_error", message },
  });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, "Request body too large", "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(req) {
  if (!config.gatewayKey) return true;
  const bearer = req.headers["authorization"];
  const apiKey = req.headers["x-api-key"];
  const presented =
    (typeof bearer === "string" && bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "") ||
    (typeof apiKey === "string" ? apiKey.trim() : "");
  return presented === config.gatewayKey;
}

function modelList() {
  const created = 1_700_000_000;
  const data = config.models.map((model) => ({
    id: model.id,
    object: "model",
    type: "model",
    created,
    created_at: new Date(created * 1000).toISOString(),
    owned_by: "z.ai",
    display_name: model.name,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
    capabilities: { vision: Boolean(model.vision) },
  }));
  return {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

function sessionIdFrom(req, body) {
  const header = req.headers["x-session-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const meta = body?.metadata;
  if (meta && typeof meta === "object" && typeof meta.session_id === "string" && meta.session_id.trim()) {
    return meta.session_id.trim();
  }
  return undefined;
}

function abortPair(req, res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

async function pipeAnthropicStream(res, upstream, controller) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders(),
  });
  try {
    for await (const chunk of upstream.body) {
      if (controller.signal.aborted) break;
      res.write(chunk);
    }
  } catch {
    /* client went away or upstream dropped mid-stream */
  } finally {
    res.end();
  }
}

async function pipeOpenAiStream(res, upstream, model, controller) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders(),
  });
  try {
    for await (const frame of anthropicSseToOpenAiSse(upstream.body, model)) {
      if (controller.signal.aborted) break;
      res.write(frame);
    }
  } catch {
    /* stream torn down */
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Anthropic-native route
// ---------------------------------------------------------------------------

async function handleAnthropic(req, res) {
  const raw = await readBody(req, config.maxBodyBytes);
  if (!raw.trim()) {
    sendAnthropicError(res, 400, "Empty request body", "invalid_request_error");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    sendAnthropicError(res, 400, `Invalid JSON: ${err.message}`, "invalid_request_error");
    return;
  }
  if (typeof parsed.model !== "string" || !parsed.model.trim()) parsed.model = config.defaultModel;
  const streaming = parsed.stream === true;
  const sessionId = sessionIdFrom(req, parsed);
  const controller = abortPair(req, res);

  const release = await acquireSlot();
  let upstream;
  try {
    upstream = await callUpstream(JSON.stringify(parsed), { sessionId, signal: controller.signal });
  } catch (err) {
    release();
    throw err;
  }

  if (!upstream.ok) {
    release();
    const { status, detail } = await describeUpstreamError(upstream);
    sendAnthropicError(res, status === 429 ? 429 : status, detail, status === 401 ? "authentication_error" : "api_error");
    return;
  }

  if (streaming && upstream.body) {
    // hold the slot for the whole stream: ZCode counts an open SSE turn as
    // in-flight, so releasing at the headers lets the next request collide.
    try {
      await pipeAnthropicStream(res, upstream, controller);
    } finally {
      release();
    }
    return;
  }

  try {
    const text = await upstream.text();
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      ...corsHeaders(),
    });
    res.end(text);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// OpenAI route
// ---------------------------------------------------------------------------

async function handleOpenAI(req, res) {
  const raw = await readBody(req, config.maxBodyBytes);
  if (!raw.trim()) {
    sendOpenAIError(res, 400, "Empty request body", "invalid_request_error");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    sendOpenAIError(res, 400, `Invalid JSON: ${err.message}`, "invalid_request_error");
    return;
  }

  const model = resolveModel(parsed.model);
  const streaming = parsed.stream === true;
  const anthropicBody = openAIToAnthropic({ ...parsed, model }, config.defaultModel);
  const sessionId = sessionIdFrom(req, parsed);
  const controller = abortPair(req, res);

  const release = await acquireSlot();
  let upstream;
  try {
    upstream = await callUpstream(JSON.stringify(anthropicBody), { sessionId, signal: controller.signal });
  } catch (err) {
    release();
    throw err;
  }

  if (!upstream.ok) {
    release();
    const { status, detail } = await describeUpstreamError(upstream);
    sendOpenAIError(res, status === 429 ? 429 : status, detail, status === 401 ? "authentication_error" : "upstream_error");
    return;
  }

  if (streaming && upstream.body) {
    try {
      await pipeOpenAiStream(res, upstream, model, controller);
    } finally {
      release();
    }
    return;
  }

  try {
    const payload = JSON.parse(await upstream.text());
    const translated = anthropicToOpenAI(payload, model);
    sendJson(res, 200, translated);
  } catch (err) {
    sendOpenAIError(res, 502, `Could not read upstream response: ${err.message}`, "upstream_error");
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (!authorized(req)) {
    if (path.startsWith("/v1/messages")) sendAnthropicError(res, 401, "Invalid gateway key", "authentication_error");
    else sendOpenAIError(res, 401, "Invalid gateway key", "authentication_error");
    return;
  }

  const isAnthropicRoute = path === "/v1/messages" || path === "/messages";

  try {
    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      sendJson(res, 200, {
        status: "ok",
        upstream: config.upstreamUrl,
        model_count: config.models.length,
        default_model: config.defaultModel,
        queue: queueStats(),
        credentials: await credentialStatus(),
      });
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      sendJson(res, 200, modelList());
      return;
    }

    if (req.method === "POST" && isAnthropicRoute) {
      await handleAnthropic(req, res);
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleOpenAI(req, res);
      return;
    }

    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, {
        name: "zcode-gateway",
        openai_base_url: `http://${config.host}:${config.port}/v1`,
        anthropic_base_url: `http://${config.host}:${config.port}`,
        default_model: config.defaultModel,
      });
      return;
    }

    if (path.startsWith("/v1/messages")) sendAnthropicError(res, 404, `No route for ${req.method} ${path}`, "not_found_error");
    else sendOpenAIError(res, 404, `No route for ${req.method} ${path}`, "not_found");
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err instanceof GatewayError ? err.status : 502;
    const code = err instanceof GatewayError ? err.code : "upstream_error";
    if (isAnthropicRoute) sendAnthropicError(res, status, err.message, code);
    else sendOpenAIError(res, status, err.message, code);
  }
});

server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(config.port, config.host, () => {
  console.log(`zcode-gateway listening on http://${config.host}:${config.port}`);
  console.log(`  OpenAI base URL     : http://${config.host}:${config.port}/v1`);
  console.log(`  Anthropic base URL  : http://${config.host}:${config.port}`);
  console.log(`  upstream            : ${config.upstreamUrl}`);
  console.log(`  models              : ${config.models.map((m) => m.id).join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

export { server, modelIds };
