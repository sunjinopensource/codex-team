import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";

import { createCodexLoginProvider } from "../src/codex-login.js";
import { createAuthPayload, jsonResponse } from "./test-helpers.js";

function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

describe("Codex login provider", () => {
  test("continues browser login when the browser opener emits an error", async () => {
    const auth = createAuthPayload("acct-browser-provider", "chatgpt", "plus", "user-browser-provider");
    const requests: Array<{ url: string; body: string }> = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    let spawnedUrl = "";
    let unrefCalled = false;
    child.unref = () => {
      unrefCalled = true;
    };

    const spawnMock: typeof spawn = ((_: string, args?: readonly string[]) => {
      spawnedUrl = args?.at(-1) ?? "";
      setTimeout(() => {
        child.emit("error", new Error("spawn xdg-open ENOENT"));
      }, 0);
      return child as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });

      if (url.endsWith("/oauth/token")) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=browser-authorization-code");
        expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    const stdout = captureWritable();
    const stderr = captureWritable();

    const snapshot = await createCodexLoginProvider(fetchMock, {
      spawnImpl: spawnMock,
      waitForBrowserCallback: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          result: {
            code: "browser-authorization-code",
            state,
          },
          redirectUri: "http://localhost:1455/auth/callback",
        };
      },
    }).login({
      mode: "browser",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-browser-provider",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
    ]);
    expect(spawnedUrl).toContain("https://auth.openai.com/oauth/authorize?");
    expect(unrefCalled).toBe(true);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Failed to open browser automatically: spawn xdg-open ENOENT");
  });

  test("escapes the authorize URL on Windows so cmd keeps the whole query string", async () => {
    const auth = createAuthPayload("acct-browser-windows", "chatgpt", "plus", "user-browser-windows");
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;

    const spawnCalls: Array<{ command: string; args?: readonly string[] }> = [];
    const spawnMock: typeof spawn = ((command: string, args?: readonly string[]) => {
      spawnCalls.push({ command, args });
      return child as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;

    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/oauth/token")) {
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${String(input)}`);
    };

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await createCodexLoginProvider(fetchMock, {
        spawnImpl: spawnMock,
        waitForBrowserCallback: async (state) => ({
          result: { code: "browser-authorization-code", state },
          redirectUri: "http://localhost:1455/auth/callback",
        }),
      }).login({
        mode: "browser",
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }

    expect(spawnCalls[0]?.command).toBe("cmd");
    const openedUrl = spawnCalls[0]?.args?.at(-1) ?? "";
    expect(openedUrl.startsWith("https://auth.openai.com/oauth/authorize?")).toBe(true);
    expect(openedUrl).toContain("^&client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    const unescapedUrl = openedUrl.replace(/\^(.)/g, "$1");
    expect(unescapedUrl).toContain("&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
    expect(unescapedUrl).toContain("&code_challenge_method=S256");
  });

  test("completes device login using Codex device endpoints", async () => {
    const auth = createAuthPayload("acct-device-provider", "chatgpt", "plus", "user-device-provider");
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "1",
        });
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
          code_challenge: "code-challenge",
        });
      }

      if (url.endsWith("/oauth/token")) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
        expect(body).toContain("code=authorization-code");
        expect(body).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
        expect(body).toContain("code_verifier=code-verifier");
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    const stdout = captureWritable();
    const stderr = captureWritable();

    const snapshot = await createCodexLoginProvider(fetchMock).login({
      mode: "device",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-device-provider",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("ABCD-EFGH");
  });
});
