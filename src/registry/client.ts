import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AccountStore } from "../account-store/index.js";
import { FILE_MODE, atomicWriteFile } from "../account-store/storage.js";

const REMOTES_FILE_NAME = "remotes.json";

export interface RemoteConfig {
  url: string;
  token: string;
}

export interface RemotesFile {
  remotes: Record<string, RemoteConfig>;
  default_remote: string | null;
}

export interface RemoteAccount {
  name: string;
  kind: string | null;
  plan_type: string | null;
  account_id: string | null;
  token_expires_at: string | null;
  updated_at: string | null;
  last_downloaded_at: string | null;
  size: number | null;
}

function remotesFilePath(store: AccountStore): string {
  return join(store.paths.codexTeamDir, REMOTES_FILE_NAME);
}

export async function readRemotesFile(store: AccountStore): Promise<RemotesFile> {
  try {
    const raw = await readFile(remotesFilePath(store), "utf8");
    const parsed = JSON.parse(raw) as Partial<RemotesFile>;
    return {
      remotes: parsed.remotes ?? {},
      default_remote: parsed.default_remote ?? null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { remotes: {}, default_remote: null };
    }
    throw error;
  }
}

async function writeRemotesFile(store: AccountStore, data: RemotesFile): Promise<void> {
  await atomicWriteFile(
    remotesFilePath(store),
    `${JSON.stringify(data, null, 2)}\n`,
    FILE_MODE,
  );
}

export async function addRemote(
  store: AccountStore,
  options: { name: string; url: string; token: string; setDefault?: boolean },
): Promise<void> {
  const data = await readRemotesFile(store);
  data.remotes[options.name] = {
    url: options.url.replace(/\/+$/u, ""),
    token: options.token,
  };
  if (options.setDefault === true || !data.default_remote) {
    data.default_remote = options.name;
  }
  await writeRemotesFile(store, data);
}

export async function removeRemote(store: AccountStore, name: string): Promise<boolean> {
  const data = await readRemotesFile(store);
  if (!data.remotes[name]) {
    return false;
  }
  delete data.remotes[name];
  if (data.default_remote === name) {
    data.default_remote = Object.keys(data.remotes)[0] ?? null;
  }
  await writeRemotesFile(store, data);
  return true;
}

export async function resolveRemote(
  store: AccountStore,
  name?: string | null,
): Promise<{ name: string; config: RemoteConfig }> {
  const data = await readRemotesFile(store);
  const resolvedName = name ?? data.default_remote;
  if (!resolvedName) {
    throw new Error(
      'No registry remote configured. Add one with: codexm remote add <name> <url> --token <token>',
    );
  }
  const config = data.remotes[resolvedName];
  if (!config) {
    const known = Object.keys(data.remotes).join(", ") || "(none)";
    throw new Error(`Unknown registry remote "${resolvedName}". Configured remotes: ${known}`);
  }
  return { name: resolvedName, config };
}

async function request(
  remote: RemoteConfig,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${remote.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${remote.token}`,
        ...(init.headers ?? {}),
      },
      body: init.body,
    });
  } catch (cause) {
    throw new Error(
      `Cannot reach registry ${remote.url}: ${(cause as Error).message}. Is the server running?`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail.trim() === "" ? "" : `: ${detail.trim().slice(0, 200)}`;
    throw new Error(`Registry ${remote.url} returned ${response.status} for ${path}${suffix}`);
  }
  return response;
}

export async function listRemoteAccounts(remote: RemoteConfig): Promise<RemoteAccount[]> {
  const response = await request(remote, "/v1/accounts");
  const payload = (await response.json()) as { accounts?: RemoteAccount[] };
  return payload.accounts ?? [];
}

export async function downloadBundle(remote: RemoteConfig, name: string): Promise<unknown> {
  const response = await request(remote, `/v1/accounts/${encodeURIComponent(name)}`);
  return await response.json();
}

export async function uploadBundle(
  remote: RemoteConfig,
  name: string,
  bundle: unknown,
): Promise<void> {
  await request(remote, `/v1/accounts/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(bundle),
    headers: { "content-type": "application/json" },
  });
}

export async function deleteRemoteAccount(remote: RemoteConfig, name: string): Promise<void> {
  await request(remote, `/v1/accounts/${encodeURIComponent(name)}`, { method: "DELETE" });
}
