import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { performUiSwitch } from "../src/commands/ui.js";
import type { CodexDesktopLauncher } from "../src/desktop/launcher.js";
import { NON_MANAGED_DESKTOP_WARNING_PREFIX } from "../src/switching.js";
import { cleanupTempHome, createTempHome, writeCurrentAuth } from "./test-helpers.js";

interface FakeLauncherCalls {
  apply: number;
  list: number;
}

function createFakeLauncher(options: {
  applyResult?: boolean;
  runningApps?: unknown[];
  managedRunning?: boolean;
} = {}): { launcher: CodexDesktopLauncher; calls: FakeLauncherCalls } {
  const calls: FakeLauncherCalls = { apply: 0, list: 0 };
  const launcher = {
    readManagedState: async () => null,
    isManagedDesktopRunning: async () => options.managedRunning ?? false,
    applyManagedSwitch: async () => {
      calls.apply += 1;
      return options.applyResult ?? true;
    },
    listRunningApps: async () => {
      calls.list += 1;
      return options.runningApps ?? [];
    },
  } as unknown as CodexDesktopLauncher;

  return { launcher, calls };
}

async function seedAccounts(homeDir: string) {
  const store = createAccountStore(homeDir);
  await writeCurrentAuth(homeDir, "acct-alpha");
  await store.saveCurrentAccount("alpha");
  await writeCurrentAuth(homeDir, "acct-beta");
  await store.saveCurrentAccount("beta");
  return store;
}

describe("console switch", () => {
  test("refreshes the managed Desktop after moving local auth", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);
      const { launcher, calls } = createFakeLauncher({ applyResult: true });

      const result = await performUiSwitch({ store, name: "beta", desktopLauncher: launcher });

      expect(result.desktop_refresh).toBe("applied");
      expect(result.proxy_retained).toBe(false);
      expect(calls.apply).toBe(1);

      const status = await store.getCurrentStatus();
      expect(status.matched_accounts).toContain("beta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("warns instead of touching a Desktop that codexm did not start", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);
      const { launcher, calls } = createFakeLauncher({
        applyResult: false,
        runningApps: [{ pid: 4242 }],
      });

      const result = await performUiSwitch({ store, name: "beta", desktopLauncher: launcher });

      expect(result.desktop_refresh).toBe("other-running");
      expect(calls.apply).toBe(1);
      expect(result.warnings).toContain(NON_MANAGED_DESKTOP_WARNING_PREFIX);

      const status = await store.getCurrentStatus();
      expect(status.matched_accounts).toContain("beta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("still switches local auth when no launcher is wired up", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);

      const result = await performUiSwitch({ store, name: "beta" });

      expect(result.desktop_refresh).toBe("skipped-no-launcher");

      const status = await store.getCurrentStatus();
      expect(status.matched_accounts).toContain("beta");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
