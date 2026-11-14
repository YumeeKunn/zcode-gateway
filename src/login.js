#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { inspectJwt, saveCredentials } from "./zcode.js";

const INIT_URL = `${config.apiBase}/oauth/cli/init`;
const POLL_URL = (flowId) => `${config.apiBase}/oauth/cli/poll/${encodeURIComponent(flowId)}`;
const INTERSTITIAL = "https://zcode.z.ai/app/oauth/login";

function envelope(raw) {
  if (!raw || typeof raw.code !== "number") return null;
  return raw;
}

async function postInit(pollToken) {
  const response = await fetch(INIT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${pollToken}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "zai" }),
  });
  const text = await response.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`login init: invalid response (status=${response.status}) ${text.slice(0, 200)}`);
  }
  const env = envelope(raw);
  if (!env) throw new Error(`login init: unexpected envelope (status=${response.status})`);
  if (!response.ok || env.code !== 0) {
    throw new Error(`login init failed: status=${response.status} msg=${env.msg ?? "(none)"}`);
  }
  const data = env.data ?? {};
  if (typeof data.flow_id !== "string" || typeof data.authorize_url !== "string") {
    throw new Error("login init: response missing flow_id/authorize_url");
  }
  return data;
}

async function pollOnce(pollToken, flowId) {
  let response;
  try {
    response = await fetch(POLL_URL(flowId), {
      method: "GET",
      headers: { authorization: `Bearer ${pollToken}` },
    });
  } catch {
    return { retry: true };
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    throw new Error(`login poll failed: status=${response.status}`);
  }
  if (!response.ok) return { retry: true };

  let raw;
  try {
    raw = JSON.parse(await response.text());
  } catch {
    return { retry: true };
  }
  const env = envelope(raw);
  if (!env) return { retry: true };
  if (env.code !== 0) throw new Error(`login poll failed: code=${env.code} msg=${env.msg ?? "(none)"}`);
  return { retry: false, data: env.data ?? null };
}

function buildAuthorizeUrl(baseUrl) {
  const url = new URL(baseUrl);
  const redirect = new URL(INTERSTITIAL);
  redirect.searchParams.set("redirect", "zcode://oauth/callback");
  redirect.searchParams.set("app_version", config.appVersion);
  url.searchParams.set("redirect_uri", redirect.toString());
  return url.toString();
}

function tryOpenBrowser(url) {
  const commands = process.platform === "darwin" ? [["open", [url]]] : process.platform === "win32" ? [["cmd", ["/c", "start", "", url]]] : [["xdg-open", [url]]];
  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  const pollToken = randomBytes(32).toString("hex");
  console.log("requesting ZCode device login...");
  const flow = await postInit(pollToken);
  const authorizeUrl = buildAuthorizeUrl(flow.authorize_url);
  const expiresAt = typeof flow.expires_at === "number" ? flow.expires_at * 1000 : Date.now() + 300_000;
  const intervalMs = Math.max(1000, (flow.poll_interval_sec ?? 3) * 1000);

  console.log("");
  console.log("open this URL and approve the login:");
  console.log("");
  console.log(`  ${authorizeUrl}`);
  console.log("");
  if (!tryOpenBrowser(authorizeUrl)) console.log("(could not launch a browser — open it manually)");
  console.log(`waiting for approval (timeout ${Math.round((expiresAt - Date.now()) / 1000)}s)...`);

  const deadline = Math.min(expiresAt, Date.now() + 600_000);
  for (;;) {
    if (Date.now() >= deadline) throw new Error("Authorization timed out. Run login again.");
    const outcome = await pollOnce(pollToken, flow.flow_id);
    if (outcome.retry) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      continue;
    }
    const data = outcome.data ?? {};
    if (data.status === "ready") {
      const accessToken = typeof data.zai?.access_token === "string" ? data.zai.access_token.trim() : "";
      const jwt = typeof data.token === "string" ? data.token.trim() : "";
      if (!jwt) throw new Error("login poll: response missing plan token (data.token)");
      await saveCredentials({
        jwt,
        accessToken: accessToken || null,
        userId: typeof data.user?.user_id === "string" ? data.user.user_id : null,
        savedAt: new Date().toISOString(),
      });
      const info = inspectJwt(jwt);
      console.log("");
      console.log("signed in.");
      console.log(`  user    : ${data.user?.user_id ?? "(unknown)"}`);
      console.log(`  jwt iat : ${info ? new Date(info.iat * 1000).toISOString() : "(unreadable)"}`);
      console.log(`  stored  : ${"data/credentials.json"}`);
      return;
    }
    if (data.status === "failed") throw new Error("Authorization failed. Run login again.");
    if (data.status !== "pending") {
      throw new Error(`login poll: unexpected status ${String(data.status ?? "(none)")}`);
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

async function storeManualToken(token) {
  const jwt = token.trim();
  if (jwt.split(".").length !== 3) throw new Error("that does not look like a JWT");
  await saveCredentials({ jwt, accessToken: null, userId: null, savedAt: new Date().toISOString() });
  const info = inspectJwt(jwt);
  console.log("stored manual token.");
  console.log(`  jwt iat : ${info ? new Date(info.iat * 1000).toISOString() : "(unreadable)"}`);
}

const argv = process.argv.slice(2);
const tokenFlag = argv.indexOf("--token");

if (tokenFlag >= 0) {
  const value = argv[tokenFlag + 1];
  if (!value) {
    console.error("usage: node src/login.js --token <jwt>");
    process.exit(1);
  }
  await storeManualToken(value);
} else {
  try {
    await login();
  } catch (err) {
    console.error(`login failed: ${err.message}`);
    process.exit(1);
  }
}
