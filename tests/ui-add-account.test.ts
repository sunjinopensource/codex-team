import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import type { AuthSnapshot } from "../src/auth-snapshot.js";
import type { CodexDeviceLoginSession, CodexLoginProvider } from "../src/codex-login.js";
import { createAccountAddFlows, performUiAddAccount } from "../src/commands/ui.js";
import {
  cleanupTempHome,
  createAuthPayload,
  createTempHome,
  writeCurrentAuth,
} from "./test-helpers.js";

function createFakeLogin(snapshot: AuthSnapshot) {
  let resolveWait: ((value: AuthSnapshot) => void) | null = null;
  let rejectWait: ((error: Error) => void) | null = null;
  let startCalls = 0;

  const session: CodexDeviceLoginSession = {
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
    intervalMs: 5,
    wait: () =>
      new Promise<AuthSnapshot>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      }),
    cancel: (reason?: string) => {
      rejectWait?.(new Error(reason ?? "已取消添加账号。"));
    },
  };

  const provider: CodexLoginProvider = {
    login: async () => snapshot,
    startDeviceLogin: async () => {
      startCalls += 1;
      return session;
    },
  };

  return {
    provider,
    approve: (value: AuthSnapshot = snapshot) => resolveWait?.(value),
    startCalls: () => startCalls,
  };
}

function providerWithoutDeviceLogin(snapshot: AuthSnapshot): CodexLoginProvider {
  return { login: async () => snapshot };
}

async function seedStore(homeDir: string) {
  const store = createAccountStore(homeDir);
  await writeCurrentAuth(homeDir, "acct-alpha");
  await store.saveCurrentAccount("alpha");
  return store;
}

describe("console add account", () => {
  test("saves an API key account immediately", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);

      const result = await performUiAddAccount({
        store,
        flows: createAccountAddFlows(),
        name: "keyed",
        method: "apikey",
        apiKey: "sk-test-key",
      });

      expect(result.status).toBe("added");
      expect(result.message).toContain("keyed");

      const { accounts } = await store.listAccounts();
      expect(accounts.map((account) => account.name)).toContain("keyed");
      expect(accounts.find((account) => account.name === "keyed")?.auth_mode).toBe("apikey");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("hands back a device code and saves the snapshot once approved", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);
      const flows = createAccountAddFlows();
      const snapshot = createAuthPayload("acct-device-add", "chatgpt", "plus", "user-device-add");
      const login = createFakeLogin(snapshot);

      const pending = await performUiAddAccount({
        store,
        authLogin: login.provider,
        flows,
        name: "gamma",
        method: "device",
      });

      expect(pending.status).toBe("pending");
      if (pending.status !== "pending") {
        throw new Error("expected a pending device flow");
      }
      expect(pending.userCode).toBe("ABCD-EFGH");
      expect(pending.verificationUrl).toBe("https://auth.openai.com/codex/device");
      expect(login.startCalls()).toBe(1);

      login.approve();
      await flows.settled();

      expect(flows.get(pending.flowId)?.status).toBe("done");
      const { accounts } = await store.listAccounts();
      expect(accounts.map((account) => account.name)).toContain("gamma");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("asks before overwriting an existing account name", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);
      const flows = createAccountAddFlows();
      const login = createFakeLogin(createAuthPayload("acct-dup", "chatgpt", "plus", "user-dup"));

      const first = await performUiAddAccount({
        store,
        authLogin: login.provider,
        flows,
        name: "alpha",
        method: "device",
      });

      expect(first.status).toBe("confirm-overwrite");
      expect(login.startCalls()).toBe(0);

      const forced = await performUiAddAccount({
        store,
        authLogin: login.provider,
        flows,
        name: "alpha",
        method: "device",
        force: true,
      });

      expect(forced.status).toBe("pending");
      expect(login.startCalls()).toBe(1);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reports a failed device login through the flow status", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);
      const flows = createAccountAddFlows();
      const login = createFakeLogin(createAuthPayload("acct-cancel", "chatgpt", "plus", "user-cancel"));

      const pending = await performUiAddAccount({
        store,
        authLogin: login.provider,
        flows,
        name: "delta",
        method: "device",
      });
      if (pending.status !== "pending") {
        throw new Error("expected a pending device flow");
      }

      flows.cancelAll();
      await flows.settled();

      const { accounts } = await store.listAccounts();
      expect(accounts.map((account) => account.name)).not.toContain("delta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("refuses device login when the provider cannot start it", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);

      await expect(
        performUiAddAccount({
          store,
          authLogin: providerWithoutDeviceLogin(
            createAuthPayload("acct-none", "chatgpt", "plus", "user-none"),
          ),
          flows: createAccountAddFlows(),
          name: "epsilon",
          method: "device",
        }),
      ).rejects.toThrow("设备码登录");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects the reserved proxy account name", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedStore(homeDir);

      await expect(
        performUiAddAccount({
          store,
          flows: createAccountAddFlows(),
          name: "proxy",
          method: "apikey",
          apiKey: "sk-test-key",
        }),
      ).rejects.toThrow();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
