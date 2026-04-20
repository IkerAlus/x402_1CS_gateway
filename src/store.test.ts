/**
 * Tests for the State Store module.
 *
 * Tests are written against the {@link StateStore} interface so they can be
 * run against any implementation. The `describeStore` helper runs the full
 * suite for both `SqliteStateStore` and `InMemoryStateStore`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SqliteStateStore,
  InMemoryStateStore,
  createStateStore,
  validatePhaseTransition,
  StateNotFoundError,
  InvalidPhaseTransitionError,
} from "./store.js";
import type { StateStore, SwapState, SwapPhase } from "./types.js";
import { VALID_PHASE_TRANSITIONS } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

/** Build a minimal valid SwapState for testing. */
function makeSwapState(overrides: Partial<SwapState> = {}): SwapState {
  const now = Date.now();
  return {
    depositAddress: "0xDEPOSIT_001",
    quoteResponse: {
      correlationId: "corr-001",
      timestamp: new Date().toISOString(),
      signature: "sig-001",
      quoteRequest: { swapType: "EXACT_OUTPUT" },
      quote: {
        depositAddress: "0xDEPOSIT_001",
        amountIn: "10500000",
        amountInFormatted: "10.50",
        amountInUsd: "10.50",
        minAmountIn: "10000000",
        amountOut: "10000000",
        amountOutFormatted: "10.00",
        amountOutUsd: "10.00",
        minAmountOut: "9950000",
        deadline: new Date(now + 300_000).toISOString(),
        timeEstimate: 60,
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "10500000",
      payTo: "0xDEPOSIT_001",
      maxTimeoutSeconds: 270,
      extra: {
        name: "USDC",
        version: "2",
        assetTransferMethod: "eip3009",
      },
    },
    phase: "QUOTED" as SwapPhase,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Shared test suite — runs against both implementations
// ═══════════════════════════════════════════════════════════════════════

function describeStore(
  name: string,
  factory: () => Promise<{ store: StateStore; cleanup: () => Promise<void> }>,
) {
  describe(name, () => {
    let store: StateStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // ── create / get ─────────────────────────────────────────────────

    it("should create and retrieve a swap state", async () => {
      const state = makeSwapState();
      await store.create(state.depositAddress, state);

      const retrieved = await store.get(state.depositAddress);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.depositAddress).toBe(state.depositAddress);
      expect(retrieved!.phase).toBe("QUOTED");
      expect(retrieved!.quoteResponse.correlationId).toBe("corr-001");
      expect(retrieved!.paymentRequirements.payTo).toBe("0xDEPOSIT_001");
    });

    it("should return null for a non-existent deposit address", async () => {
      const result = await store.get("0xNON_EXISTENT");
      expect(result).toBeNull();
    });

    it("should overwrite on create with same deposit address (idempotent)", async () => {
      const state1 = makeSwapState({ depositAddress: "0xABC" });
      await store.create("0xABC", state1);

      const state2 = makeSwapState({
        depositAddress: "0xABC",
        phase: "QUOTED",
        quoteResponse: {
          ...state1.quoteResponse,
          correlationId: "corr-002",
        },
      });
      await store.create("0xABC", state2);

      const retrieved = await store.get("0xABC");
      expect(retrieved!.quoteResponse.correlationId).toBe("corr-002");
    });

    it("should preserve all SwapState fields through serialization", async () => {
      const state = makeSwapState({
        paymentPayload: {
          x402Version: 2,
          accepted: makeSwapState().paymentRequirements,
          payload: { authorization: "0xSIG" },
        },
        signerAddress: "0xBUYER",
        originTxHash: "0xTXHASH",
        oneClickStatus: "SUCCESS",
        settledAt: Date.now(),
        settlementResponse: {
          success: true,
          transaction: "0xTXHASH",
          network: "eip155:8453",
          extra: {
            settlementType: "crosschain-1cs",
            swapStatus: "SUCCESS",
            correlationId: "corr-001",
          },
        },
        error: undefined,
      });

      await store.create(state.depositAddress, state);
      const retrieved = await store.get(state.depositAddress);

      expect(retrieved!.paymentPayload?.x402Version).toBe(2);
      expect(retrieved!.signerAddress).toBe("0xBUYER");
      expect(retrieved!.originTxHash).toBe("0xTXHASH");
      expect(retrieved!.oneClickStatus).toBe("SUCCESS");
      expect(retrieved!.settledAt).toBeDefined();
      expect(retrieved!.settlementResponse?.success).toBe(true);
      expect(retrieved!.settlementResponse?.extra?.settlementType).toBe(
        "crosschain-1cs",
      );
    });

    // ── update ────────────────────────────────────────────────────────

    it("should update state with a partial patch", async () => {
      const state = makeSwapState();
      await store.create(state.depositAddress, state);

      await store.update(state.depositAddress, {
        phase: "VERIFIED",
        signerAddress: "0xBUYER",
      });

      const retrieved = await store.get(state.depositAddress);
      expect(retrieved!.phase).toBe("VERIFIED");
      expect(retrieved!.signerAddress).toBe("0xBUYER");
      // Original fields preserved
      expect(retrieved!.quoteResponse.correlationId).toBe("corr-001");
    });

    it("should update updatedAt on patch", async () => {
      const state = makeSwapState({ createdAt: 1000, updatedAt: 1000 });
      await store.create(state.depositAddress, state);

      const beforeUpdate = Date.now();
      await store.update(state.depositAddress, { phase: "VERIFIED" });

      const retrieved = await store.get(state.depositAddress);
      expect(retrieved!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
      expect(retrieved!.createdAt).toBe(1000); // unchanged
    });

    it("should throw StateNotFoundError when updating non-existent state", async () => {
      await expect(
        store.update("0xNON_EXISTENT", { phase: "VERIFIED" }),
      ).rejects.toThrow(StateNotFoundError);
    });

    it("should allow valid phase transition QUOTED → VERIFIED", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      await expect(
        store.update(state.depositAddress, { phase: "VERIFIED" }),
      ).resolves.not.toThrow();
    });

    it("should allow valid phase transition QUOTED → EXPIRED", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      await expect(
        store.update(state.depositAddress, { phase: "EXPIRED" }),
      ).resolves.not.toThrow();
    });

    it("should allow valid phase transition QUOTED → FAILED", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      await expect(
        store.update(state.depositAddress, { phase: "FAILED" }),
      ).resolves.not.toThrow();
    });

    it("should reject invalid phase transition QUOTED → SETTLED", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      await expect(
        store.update(state.depositAddress, { phase: "SETTLED" }),
      ).rejects.toThrow(InvalidPhaseTransitionError);
    });

    it("should reject transitions from terminal states", async () => {
      for (const terminal of ["SETTLED", "FAILED", "EXPIRED"] as SwapPhase[]) {
        const state = makeSwapState({
          depositAddress: `0x_${terminal}`,
          phase: terminal,
        });
        await store.create(state.depositAddress, state);

        await expect(
          store.update(state.depositAddress, { phase: "QUOTED" }),
        ).rejects.toThrow(InvalidPhaseTransitionError);
      }
    });

    it("should allow update without phase change (no transition validation)", async () => {
      const state = makeSwapState({ phase: "POLLING" });
      await store.create(state.depositAddress, state);

      // Updating status without changing phase should be fine
      await expect(
        store.update(state.depositAddress, { oneClickStatus: "PROCESSING" }),
      ).resolves.not.toThrow();
    });

    it("should walk through the full happy-path lifecycle", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      const transitions: SwapPhase[] = [
        "VERIFIED",
        "BROADCASTING",
        "BROADCAST",
        "POLLING",
        "SETTLED",
      ];

      for (const nextPhase of transitions) {
        await store.update(state.depositAddress, { phase: nextPhase });
        const current = await store.get(state.depositAddress);
        expect(current!.phase).toBe(nextPhase);
      }
    });

    // ── listExpired ──────────────────────────────────────────────────

    it("should list states older than the threshold", async () => {
      const old = makeSwapState({
        depositAddress: "0xOLD",
        createdAt: 1000,
      });
      const recent = makeSwapState({
        depositAddress: "0xRECENT",
        createdAt: Date.now(),
      });

      await store.create("0xOLD", old);
      await store.create("0xRECENT", recent);

      const expired = await store.listExpired(5000);
      expect(expired).toContain("0xOLD");
      expect(expired).not.toContain("0xRECENT");
    });

    it("should return empty array when no states are expired", async () => {
      const state = makeSwapState({ createdAt: Date.now() });
      await store.create(state.depositAddress, state);

      const expired = await store.listExpired(1000);
      expect(expired).toEqual([]);
    });

    // ── listByPhase ─────────────────────────────────────────────────

    it("should list states matching the given phase", async () => {
      await store.create("0xA", makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }));
      await store.create("0xB", makeSwapState({ depositAddress: "0xB", phase: "QUOTED" }));
      // Transition 0xB to BROADCASTING via valid path
      await store.update("0xB", { phase: "VERIFIED" });
      await store.update("0xB", { phase: "BROADCASTING" });
      await store.create("0xC", makeSwapState({ depositAddress: "0xC", phase: "QUOTED" }));
      await store.update("0xC", { phase: "VERIFIED" });
      await store.update("0xC", { phase: "BROADCASTING" });
      await store.update("0xC", {
        phase: "BROADCAST",
        originTxHash: "0xTX123",
      });
      await store.update("0xC", { phase: "POLLING" });

      const broadcasting = await store.listByPhase("BROADCASTING");
      expect(broadcasting).toHaveLength(1);
      expect(broadcasting[0]!.depositAddress).toBe("0xB");

      const polling = await store.listByPhase("POLLING");
      expect(polling).toHaveLength(1);
      expect(polling[0]!.depositAddress).toBe("0xC");

      const quoted = await store.listByPhase("QUOTED");
      expect(quoted).toHaveLength(1);
      expect(quoted[0]!.depositAddress).toBe("0xA");
    });

    it("should return empty array when no states match the phase", async () => {
      await store.create("0xA", makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }));
      const result = await store.listByPhase("POLLING");
      expect(result).toEqual([]);
    });

    it("should return deep copies from listByPhase", async () => {
      await store.create("0xA", makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }));
      const [first] = await store.listByPhase("QUOTED");
      first!.depositAddress = "MUTATED";

      const [second] = await store.listByPhase("QUOTED");
      expect(second!.depositAddress).toBe("0xA");
    });

    // ── delete ────────────────────────────────────────────────────────

    it("should delete a swap state", async () => {
      const state = makeSwapState();
      await store.create(state.depositAddress, state);

      await store.delete(state.depositAddress);
      const retrieved = await store.get(state.depositAddress);
      expect(retrieved).toBeNull();
    });

    it("should not throw when deleting a non-existent state", async () => {
      await expect(store.delete("0xNON_EXISTENT")).resolves.not.toThrow();
    });

    // ── multiple states ──────────────────────────────────────────────

    it("should handle multiple independent swap states", async () => {
      const state1 = makeSwapState({ depositAddress: "0xA" });
      const state2 = makeSwapState({ depositAddress: "0xB" });
      const state3 = makeSwapState({ depositAddress: "0xC" });

      await store.create("0xA", state1);
      await store.create("0xB", state2);
      await store.create("0xC", state3);

      // Update one, others unaffected
      await store.update("0xB", { phase: "VERIFIED" });

      expect((await store.get("0xA"))!.phase).toBe("QUOTED");
      expect((await store.get("0xB"))!.phase).toBe("VERIFIED");
      expect((await store.get("0xC"))!.phase).toBe("QUOTED");
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Run shared suite against both implementations
// ═══════════════════════════════════════════════════════════════════════

describeStore("SqliteStateStore", async () => {
  const store = new SqliteStateStore(); // in-memory SQLite
  await store.init();
  return {
    store,
    cleanup: () => store.close(),
  };
});

describeStore("InMemoryStateStore", async () => {
  const store = new InMemoryStateStore();
  return {
    store,
    cleanup: async () => store.clear(),
  };
});

// ═══════════════════════════════════════════════════════════════════════
// SQLite-specific tests
// ═══════════════════════════════════════════════════════════════════════

describe("SqliteStateStore (specific)", () => {
  it("should throw if used before init()", async () => {
    const store = new SqliteStateStore();
    // Not calling init()
    await expect(store.get("0xABC")).rejects.toThrow("not initialized");
  });

  it("should support listByPhase", async () => {
    const store = new SqliteStateStore();
    await store.init();

    await store.create(
      "0xA",
      makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }),
    );
    await store.create(
      "0xB",
      makeSwapState({ depositAddress: "0xB", phase: "QUOTED" }),
    );
    await store.create(
      "0xC",
      makeSwapState({ depositAddress: "0xC", phase: "POLLING" }),
    );

    const quoted = await store.listByPhase("QUOTED");
    expect(quoted).toHaveLength(2);
    expect(quoted.map((s) => s.depositAddress).sort()).toEqual(["0xA", "0xB"]);

    const polling = await store.listByPhase("POLLING");
    expect(polling).toHaveLength(1);
    expect(polling[0].depositAddress).toBe("0xC");

    await store.close();
  });

  it("should support countByPhase", async () => {
    const store = new SqliteStateStore();
    await store.init();

    await store.create(
      "0xA",
      makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }),
    );
    await store.create(
      "0xB",
      makeSwapState({ depositAddress: "0xB", phase: "QUOTED" }),
    );
    await store.create(
      "0xC",
      makeSwapState({ depositAddress: "0xC", phase: "POLLING" }),
    );

    const counts = await store.countByPhase();
    expect(counts["QUOTED"]).toBe(2);
    expect(counts["POLLING"]).toBe(1);

    await store.close();
  });

  it("should support count", async () => {
    const store = new SqliteStateStore();
    await store.init();

    expect(await store.count()).toBe(0);

    await store.create(
      "0xA",
      makeSwapState({ depositAddress: "0xA" }),
    );
    expect(await store.count()).toBe(1);

    await store.create(
      "0xB",
      makeSwapState({ depositAddress: "0xB" }),
    );
    expect(await store.count()).toBe(2);

    await store.delete("0xA");
    expect(await store.count()).toBe(1);

    await store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validatePhaseTransition (unit tests)
// ═══════════════════════════════════════════════════════════════════════

describe("validatePhaseTransition", () => {
  it("should accept all valid transitions from the lifecycle map", () => {
    for (const [from, allowedSet] of VALID_PHASE_TRANSITIONS) {
      for (const to of allowedSet) {
        expect(() => validatePhaseTransition(from, to)).not.toThrow();
      }
    }
  });

  it("should reject all invalid transitions", () => {
    const allPhases: SwapPhase[] = [
      "QUOTED",
      "VERIFIED",
      "BROADCASTING",
      "BROADCAST",
      "POLLING",
      "SETTLED",
      "FAILED",
      "EXPIRED",
    ];

    for (const from of allPhases) {
      const allowed = VALID_PHASE_TRANSITIONS.get(from) ?? new Set();
      for (const to of allPhases) {
        if (from === to) continue; // same-phase is not a transition
        if (allowed.has(to)) continue; // valid transition
        expect(() => validatePhaseTransition(from, to)).toThrow(
          InvalidPhaseTransitionError,
        );
      }
    }
  });

  it("should include phase names in error message", () => {
    try {
      validatePhaseTransition("SETTLED", "QUOTED");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPhaseTransitionError);
      const e = err as InvalidPhaseTransitionError;
      expect(e.fromPhase).toBe("SETTLED");
      expect(e.toPhase).toBe("QUOTED");
      expect(e.message).toContain("SETTLED");
      expect(e.message).toContain("QUOTED");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// createStateStore factory
// ═══════════════════════════════════════════════════════════════════════

describe("createStateStore", () => {
  it("should create a SqliteStateStore by default", async () => {
    const store = await createStateStore();
    // Verify it works
    await store.create("0xTEST", makeSwapState({ depositAddress: "0xTEST" }));
    const result = await store.get("0xTEST");
    expect(result).not.toBeNull();
    // Clean up
    if ("close" in store) await (store as SqliteStateStore).close();
  });

  it("should create a SqliteStateStore when backend is 'sqlite'", async () => {
    const store = await createStateStore({ backend: "sqlite" });
    await store.create("0xTEST", makeSwapState({ depositAddress: "0xTEST" }));
    expect(await store.get("0xTEST")).not.toBeNull();
    if ("close" in store) await (store as SqliteStateStore).close();
  });

  it("should create an InMemoryStateStore when backend is 'memory'", async () => {
    const store = await createStateStore({ backend: "memory" });
    expect(store).toBeInstanceOf(InMemoryStateStore);
    await store.create("0xTEST", makeSwapState({ depositAddress: "0xTEST" }));
    expect(await store.get("0xTEST")).not.toBeNull();
  });

  it("should throw on unknown backend", async () => {
    await expect(
      createStateStore({ backend: "redis" as "sqlite" }),
    ).rejects.toThrow("Unknown state store backend");
  });
});
