import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

describe("MutationDrainLatch", () => {
	it("rejects an already-aborted wait even when no mutations are active", async () => {
		const latch = new MutationDrainLatch();
		const controller = new AbortController();
		controller.abort();
		const addEventListener = vi.spyOn(controller.signal, "addEventListener");

		await expect(latch.waitForDrain(0, controller.signal, "drain cancelled")).rejects.toThrow("drain cancelled");
		expect(addEventListener).not.toHaveBeenCalled();
	});

	it("keeps abort terminal when draining and aborting concurrently without leaking its listener", async () => {
		const latch = new MutationDrainLatch();
		const controller = new AbortController();
		const addEventListener = vi.spyOn(controller.signal, "addEventListener");
		const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
		latch.begin();

		const drained = latch.waitForDrain(0, controller.signal, "drain cancelled");
		latch.end();
		controller.abort();

		await expect(drained).rejects.toThrow("drain cancelled");
		expect(addEventListener).toHaveBeenCalledOnce();
		expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledOnce();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("does not wait for a mutation that is older than the stale threshold", async () => {
		const latch = new MutationDrainLatch();
		latch.begin({ type: "prompt_and_wait", id: "cmd-old" }, Date.now() - 60_000);

		await expect(
			latch.waitForDrain(0, AbortSignal.timeout(250), "drain cancelled", { staleAfterMs: 5_000 }),
		).resolves.toBeUndefined();
	});

	it("waits for a fresh mutation and resolves once it ends", async () => {
		const latch = new MutationDrainLatch();
		const token = latch.begin({ type: "rename", id: "cmd-quick" });

		const drained = latch.waitForDrain(0, AbortSignal.timeout(5_000), "drain cancelled", {
			staleAfterMs: 60_000,
		});
		latch.end(token);

		await expect(drained).resolves.toBeUndefined();
	});

	it("treats a fresh mutation as stale once it crosses the per-mutation threshold", async () => {
		const latch = new MutationDrainLatch();
		latch.begin({ type: "send_message", id: "cmd-slow" }, Date.now() - 40);

		await expect(
			latch.waitForDrain(0, AbortSignal.timeout(5_000), "drain cancelled", { staleAfterMs: 60 }),
		).resolves.toBeUndefined();
	});

	it("names the active mutations when the drain is aborted while they are fresh", async () => {
		const latch = new MutationDrainLatch();
		const controller = new AbortController();
		latch.begin({ type: "prompt", id: "cmd-hang", clientId: "client-9" }, Date.now() - 100);

		const drained = latch.waitForDrain(0, controller.signal, "drain cancelled", { staleAfterMs: 60_000 });
		controller.abort();

		await expect(drained).rejects.toThrow(/cmd-hang/);
		await expect(drained).rejects.toThrow(/prompt/);
	});

	it("ends the exact token and keeps other mutations active", async () => {
		const latch = new MutationDrainLatch();
		const first = latch.begin({ type: "rename", id: "cmd-1" });
		const second = latch.begin({ type: "kill", id: "cmd-2" });

		latch.end(first);
		expect(latch.activeMutations()).toHaveLength(1);
		expect(latch.activeMutations()[0]).toMatchObject({ type: "kill", id: "cmd-2" });

		latch.end(second);
		expect(latch.activeMutations()).toHaveLength(0);
	});
});
