import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const paths = {
  root,
  data: path.join(root, "data"),
  credentials: path.join(root, "data", "credentials.json"),
  state: path.join(root, "data", "state.json"),
};

// Stable per-install device id. The official client keeps it in
// ~/.zcode/v2/telemetry-state.json; reusing that value keeps the gateway
// indistinguishable from the desktop app on the same machine.
function resolveDeviceMid() {
  const fromEnv = str("ZCODE_DEVICE_MID", "");
  if (fromEnv) return fromEnv;

  const zcodeState = path.join(os.homedir(), ".zcode", "v2", "telemetry-state.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(zcodeState, "utf8"));
    if (typeof parsed?.deviceMid === "string" && parsed.deviceMid.length > 0) {
      return parsed.deviceMid;
    }
  } catch {
    /* no local ZCode install — fall through to our own state file */
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    if (typeof parsed?.deviceMid === "string" && parsed.deviceMid.length > 0) {
      return parsed.deviceMid;
    }
  } catch {
    /* first run */
  }

  const generated = randomUUID();
  try {
    fs.mkdirSync(paths.data, { recursive: true });
    fs.writeFileSync(paths.state, JSON.stringify({ deviceMid: generated }, null, 2), { mode: 0o600 });
  } catch {
    /* read-only fs — the id just won't persist */
  }
  return generated;
}

const platform = process.platform;
const osCategory = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

function clientLanguage() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

function clientTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const config = {
  host: str("ZCODE_GATEWAY_HOST", "127.0.0.1"),
  port: int("ZCODE_GATEWAY_PORT", 8790),

  // start-plan gateway. The official client posts Anthropic messages here.
  upstreamUrl: str(
    "ZCODE_UPSTREAM_URL",
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
  ),
  apiBase: "https://zcode.z.ai/api/v1",

  // Identity headers — mirrored from the official client so upstream sees a
  // real ZCode request.
  appVersion: str("ZCODE_APP_VERSION", "3.18.2"),
  sdkUserAgent: "ai-sdk/anthropic/3.0.81",
  refererOrigin: str("ZCODE_REFERER_ORIGIN", "https://zcode.z.ai"),
  sourceTitle: str("ZCODE_SOURCE_TITLE", "ZCode"),
  releaseChannel: str("ZCODE_RELEASE_CHANNEL", "production"),
  clientLanguage: str("ZCODE_CLIENT_LANGUAGE", clientLanguage()),
  clientTimezone: str("ZCODE_CLIENT_TIMEZONE", clientTimezone()),
  platform: `${platform}-${arch}`,
  osCategory,
  osVersion: str("ZCODE_OS_VERSION", os.release()),

  deviceMid: resolveDeviceMid(),

  // The start-plan gateway inspects the system field and rejects requests
  // without the ZCode identity blocks (error 3012). Disable only for probing.
  injectSystem: bool("ZCODE_INJECT_SYSTEM", true),

  defaultModel: str("ZCODE_DEFAULT_MODEL", "glm-5.3"),

  // Keep it low: a single ZCode session normally issues one turn at a time.
  maxConcurrency: int("ZCODE_MAX_CONCURRENCY", 4),
  maxBodyBytes: int("ZCODE_MAX_BODY_BYTES", 64 * 1024 * 1024),

  // Optional client auth for the local gateway itself.
  gatewayKey: str("ZCODE_GATEWAY_KEY", ""),

  // What the plan actually serves. Upstream answers "model not allowed" for
  // anything outside this set, so the catalog stops at these two.
  models: [
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, vision: false },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000, vision: true },
  ],
};

export const modelIds = new Set(config.models.map((m) => m.id));

export function resolveModel(requested) {
  const id = typeof requested === "string" ? requested.trim() : "";
  return id.length > 0 ? id : config.defaultModel;
}
