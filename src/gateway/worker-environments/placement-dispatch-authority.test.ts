import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement cancellation and reclaim authority", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  const createTestHarness = (options: Parameters<typeof createHarness>[1] = {}) =>
    createHarness(placementStore, { workspacePath: path.join(root, "workspace"), ...options });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-reclaim-auth-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["requested", "syncing", "starting"] as const)(
    "does not activate after Stop closes the %s dispatch owner",
    async (stage) => {
      const controller = new AbortController();
      const harness = createTestHarness();
      await expect(
        harness.service.dispatch(
          REQUEST,
          (placement) => {
            if (placement.state === stage) {
              controller.abort(new Error("Stop dispatch"));
            }
          },
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow("Stop dispatch");
      expect(harness.log).not.toContain("activation");
      expect(harness.placements.current()?.state).toBe("failed");
      if (stage === "requested") {
        expect(harness.environments.create).not.toHaveBeenCalled();
      } else {
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
      }
    },
  );

  it("passes the Move admission signal through destination provisioning", async () => {
    const harness = createTestHarness();
    const active = await harness.service.dispatch(REQUEST);
    database.db
      .prepare(`INSERT INTO worker_environments (
      environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id,
      lease_id, state, owner_epoch, attached_session_ids_json, created_at_ms, updated_at_ms, state_changed_at_ms
    ) VALUES (?, 'fake', ?, '{}', 'move-source', 'lease-1', 'attached', ?, ?, 1000, 1000, 1000)`)
      .run(
        active.environmentId,
        REQUEST.profileId,
        active.activeOwnerEpoch,
        JSON.stringify([active.sessionId]),
      );
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    const controller = new AbortController();
    let provisionSignal: AbortSignal | undefined;
    vi.mocked(harness.environments.create).mockImplementation(
      async (_profile, _id, _machine, _mode, signal) => {
        provisionSignal = signal;
        entered.resolve();
        await settled.promise;
        signal?.throwIfAborted();
        throw new Error("destination unexpectedly finished");
      },
    );
    const moving = harness.service
      .move(
        {
          ...REQUEST,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "destination" },
        },
        undefined,
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error);
    await Promise.race([
      entered.promise,
      moving.then((error) => {
        throw error;
      }),
    ]);
    try {
      controller.abort(new Error("Stop Move"));
      expect(provisionSignal?.aborted).toBe(true);
    } finally {
      settled.resolve();
      await moving;
    }
    expect(await moving).toMatchObject({ message: "Stop Move" });
    expect(harness.placements.current()?.state).toBe("failed");
    expect(harness.log.filter((event) => event === "activation")).toHaveLength(1);
  });

  it("stops final effects when authority closes during workspace reconciliation", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterReconcile: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.log).toContain("workspace:reconcile");
    expect(harness.log).toContain("workspace:resume");
    expect(harness.log).not.toContain("teardown:destroy");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "draining" });
  });

  it("finishes durable placement completion when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterDestroy: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "reclaimed" });

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
  });

  it("stops failed-placement teardown when authority closes after tunnel cleanup", async () => {
    let authorized = true;
    let revokeAfterStop = false;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterStopTunnel: () => {
        if (revokeAfterStop) {
          authorized = false;
        }
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    revokeAfterStop = true;
    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("finishes failed-placement bookkeeping when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterDestroy: () => {
        authorized = false;
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "local" });

    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.placements.current()).toMatchObject({ state: "local" });
  });
});
