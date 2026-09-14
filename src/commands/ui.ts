import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AccountStore } from "../account-store/index.js";
import { runAuthRefreshSweep } from "../auth-refresh.js";
import { listRemoteAccounts, resolveRemote } from "../registry/client.js";
import { switchAccountPreservingProxyRuntime } from "../switching.js";
import { syncAccountsToRemote } from "./remote.js";

type DebugLogger = (message: string) => void;

/**
 * The console is its own presentation surface: it renders raw quota values
 * (percent used, reset times) instead of the terminal color/truncation rules
 * in `src/cli/quota-display.ts`. All state transitions still go through the
 * shared store/paths used by the CLI.
 */

function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codexm 控制台</title>
<style>
  :root {
    --bg: #0b0f17;
    --panel: #131a26;
    --panel-2: #182131;
    --line: #24303f;
    --text: #e6edf6;
    --muted: #8b9bb0;
    --accent: #5b8cff;
    --ok: #3fb950;
    --warn: #d9a03a;
    --hot: #f0603a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(1200px 600px at 20% -10%, #17233a 0%, var(--bg) 60%);
    color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 20px 28px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: rgba(11,15,23,.85); backdrop-filter: blur(8px);
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: .2px; }
  h1 span { color: var(--muted); font-weight: 400; }
  .meta { color: var(--muted); font-size: 12.5px; }
  .spacer { flex: 1; }
  button {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
    transition: border-color .15s, background .15s, transform .05s;
  }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08101f; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  main { padding: 24px 28px 48px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .card {
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--line); border-radius: 14px; padding: 18px;
  }
  .card.current { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(91,140,255,.25); }
  .card-top { display: flex; align-items: baseline; gap: 10px; }
  .name { font-size: 16px; font-weight: 650; }
  .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted); text-transform: uppercase; letter-spacing: .4px;
  }
  .badge.live { color: var(--ok); border-color: rgba(63,185,80,.4); }
  .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .meters { margin: 16px 0 14px; display: grid; gap: 12px; }
  .meter-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  .track { height: 7px; background: #0c121c; border-radius: 999px; overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; transition: width .4s ease; }
  .fill.ok { background: var(--ok); }
  .fill.warn { background: var(--warn); }
  .fill.hot { background: var(--hot); }
  .card-actions { display: flex; gap: 8px; }
  .empty { color: var(--muted); padding: 40px 28px; }
  #toast {
    position: fixed; right: 20px; bottom: 20px; display: grid; gap: 8px; z-index: 10;
  }
  .toast {
    background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 420px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  .toast.error { border-left-color: var(--hot); }
  .toast.good { border-left-color: var(--ok); }
</style>
</head>
<body>
<header>
  <h1>codexm <span>控制台</span></h1>
  <div class="meta" id="meta">加载中…</div>
  <div class="spacer"></div>
  <button id="refreshBtn">刷新配额</button>
  <button id="syncBtn">同步到 registry</button>
  <button id="quitBtn">退出</button>
</header>
<main id="grid"></main>
<div id="toast"></div>
<script>
  const token = new URLSearchParams(location.search).get("token") || "";
  const grid = document.getElementById("grid");
  const meta = document.getElementById("meta");
  const toastBox = document.getElementById("toast");
  let busy = false;

  function toast(message, kind) {
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = message;
    toastBox.appendChild(node);
    setTimeout(() => node.remove(), 5000);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function api(path, method, body) {
    return fetch(path + "?token=" + encodeURIComponent(token), {
      method: method || "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async function (response) {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || ("请求失败（" + response.status + "）"));
      }
      return payload;
    });
  }

  function level(used) {
    if (used == null) return "ok";
    return used >= 80 ? "hot" : used >= 50 ? "warn" : "ok";
  }

  function meter(label, window) {
    if (!window) return "";
    const used = window.used_percent == null ? null : Math.max(0, Math.min(100, Math.round(window.used_percent)));
    const remaining = used == null ? null : 100 - used;
    return '<div>' +
      '<div class="meter-label"><span>' + esc(label) + '</span><span>' +
        (used == null ? "—" : "剩余 " + remaining + "%") +
      '</span></div>' +
      '<div class="track"><div class="fill ' + level(used) + '" style="width:' + (used == null ? 0 : used) + '%"></div></div>' +
      '</div>';
  }

  function resetHint(value) {
    if (!value) return "";
    const date = new Date(value);
    if (isNaN(date.getTime())) return "";
    const minutes = Math.round((date.getTime() - Date.now()) / 60000);
    if (minutes <= 0) return "即将重置";
    if (minutes < 60) return minutes + " 分钟后重置";
    const hours = Math.round(minutes / 60);
    return hours < 24 ? hours + " 小时后重置" : Math.round(hours / 24) + " 天后重置";
  }

  function render(state) {
    const accounts = state.accounts || [];
    meta.textContent = accounts.length + " 个账号 · " +
      (state.remote ? "registry " + state.remote.name + "（" + (state.remote.accounts || []).length + " 个）" : "未配置 registry") +
      (state.warnings && state.warnings.length ? " · " + state.warnings.length + " 条警告" : "");

    if (!accounts.length) {
      grid.innerHTML = '<div class="empty">还没有托管账号。用 <code>codexm save</code> 保存当前账号，或导入一个 share bundle。</div>';
      return;
    }

    grid.innerHTML = accounts.map(function (account) {
      const quota = account.quota || {};
      const five = quota.five_hour || null;
      const week = quota.one_week || null;
      const plan = quota.plan_type || account.auth_mode || "—";
      const status = quota.available || "unknown";
      const statusLabel = status === "available" ? "可用" : status === "unknown" ? "未知" : "不可用";
      const blocked = status !== "available";
      return '<div class="card' + (account.current ? " current" : "") + '">' +
        '<div class="card-top">' +
          '<div class="name">' + esc(account.name) + '</div>' +
          '<div class="badge' + (account.current ? " live" : "") + '">' + esc(account.current ? "使用中" : statusLabel) + '</div>' +
        '</div>' +
        '<div class="sub">' + esc(plan) + ' · ' + esc(account.account_id || "无账号 ID") +
          (blocked && quota.error_message ? " · " + esc(quota.error_message) : "") + '</div>' +
        '<div class="meters">' +
          meter("5 小时" + (five ? " · " + resetHint(five.reset_at) : ""), five) +
          meter("每周" + (week ? " · " + resetHint(week.reset_at) : ""), week) +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="primary" data-switch="' + esc(account.name) + '"' + (account.current ? " disabled" : "") + '>' +
            (account.current ? "使用中" : "切换到此账号") +
          '</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function reload() {
    try {
      render(await api("/api/state"));
    } catch (error) {
      meta.textContent = "不可用";
      toast(error.message, "error");
    }
  }

  async function act(path, body, message) {
    if (busy) return;
    busy = true;
    try {
      const payload = await api(path, "POST", body || {});
      toast(payload.message || message || "完成", "good");
      await reload();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy = false;
    }
  }

  grid.addEventListener("click", function (event) {
    const target = event.target.closest("button[data-switch]");
    if (!target) return;
    act("/api/switch", { name: target.getAttribute("data-switch") }, "已切换");
  });

  document.getElementById("refreshBtn").addEventListener("click", function () {
    act("/api/refresh", {}, "配额已刷新");
  });
  document.getElementById("syncBtn").addEventListener("click", function () {
    act("/api/sync", {}, "同步完成");
  });
  document.getElementById("quitBtn").addEventListener("click", async function () {
    try { await api("/api/quit", "POST", {}); } catch (error) { /* server is gone */ }
    document.body.innerHTML = '<div class="empty">控制台已停止，可以关闭此标签页。</div>';
  });

  reload();
  setInterval(reload, 5000);
</script>
</body>
</html>`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function buildState(store: AccountStore): Promise<Record<string, unknown>> {
  const { accounts, warnings } = await store.listAccounts();
  const current = await store.getCurrentStatus();
  const currentNames = new Set(current.matched_accounts ?? []);

  let remote: { name: string; accounts: unknown[] } | null = null;
  try {
    const resolved = await resolveRemote(store, null);
    remote = { name: resolved.name, accounts: await listRemoteAccounts(resolved.config) };
  } catch {
    remote = null;
  }

  return {
    accounts: accounts.map((account) => ({
      name: account.name,
      auth_mode: account.auth_mode,
      account_id: account.account_id,
      current: currentNames.has(account.name),
      updated_at: account.updated_at,
      quota: account.quota,
    })),
    current: {
      exists: current.exists,
      managed: current.managed,
      identity: current.identity,
      matched_accounts: current.matched_accounts ?? [],
    },
    remote,
    warnings,
  };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Never fail the console just because a browser could not be launched.
  }
}

export async function handleUiCommand(options: {
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  portOption?: string | null;
  noOpen?: boolean;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { store, stdout } = options;

  let requestedPort = 0;
  if (options.portOption) {
    requestedPort = Number.parseInt(options.portOption, 10);
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw new Error(`Invalid --port value "${options.portOption}". Expected a port between 1 and 65535.`);
    }
  }

  const token = randomBytes(24).toString("base64url");
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const supplied =
        url.searchParams.get("token") ??
        (Array.isArray(req.headers["x-codexm-token"])
          ? req.headers["x-codexm-token"][0]
          : req.headers["x-codexm-token"]);

      // Loopback-only, but any page you visit could still probe localhost, so
      // every request has to carry the one-shot token.
      if (supplied !== token) {
        sendJson(res, 401, { error: "未授权" });
        return;
      }

      try {
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(renderPage());
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") {
          sendJson(res, 200, await buildState(store));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/switch") {
          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : "";
          if (name === "") {
            sendJson(res, 400, { error: "缺少账号名称" });
            return;
          }
          const result = await switchAccountPreservingProxyRuntime({ store, name });
          sendJson(res, 200, {
            ok: true,
            message: `已切换到「${name}」。`,
            proxy_retained: result.proxyRetained,
            warnings: result.result.warnings,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/refresh") {
          const sweep = await runAuthRefreshSweep({ store });
          sendJson(res, 200, {
            ok: true,
            message: `刷新成功 ${sweep.refreshed.length} 个，失败 ${sweep.failed.length} 个，跳过 ${sweep.skipped.length} 个。`,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/sync") {
          const summary = await syncAccountsToRemote({ store });
          sendJson(res, 200, {
            ok: summary.failed === 0,
            message: `同步完成：推送 ${summary.pushed} 个，跳过 ${summary.skipped} 个，失败 ${summary.failed} 个。`,
            summary,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/quit") {
          sendJson(res, 200, { ok: true, message: "stopping" });
          res.on("finish", shutdown);
          return;
        }

        sendJson(res, 404, { error: "未找到" });
      } catch (error) {
        options.debugLog?.(`ui: ${(error as Error).message}`);
        sendJson(res, 500, { error: (error as Error).message });
      }
    })();
  });

  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(() => resolveClosed?.());
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  process.once("SIGINT", shutdown);
  stdout.write(`codexm 控制台已启动：${url}\n`);
  stdout.write("按 Ctrl+C 停止服务。\n");

  if (options.noOpen !== true) {
    openBrowser(url);
  }

  await closed;
  stdout.write("codexm 控制台已停止。\n");
  return 0;
}
