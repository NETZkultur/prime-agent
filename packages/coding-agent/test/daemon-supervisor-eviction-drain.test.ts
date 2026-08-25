import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
		createCommand: { type: "create"; config?: { sessionDir?: string } };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	updateRestartPrepareClient?: object;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	mutationDrain: MutationDrainLatch;
	idleEvictionFence?: Promise<void>;
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	runIdleEvictionSweep(now?: number): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, now: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date(now - 120 * 60_000).toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeWorker(id: string, summaries: SessionSummary[]): WorkerFixture {
	const client = {
		request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
		requestWorker: vi.fn(),
		close: vi.fn(),
	};
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-descriptor-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client,
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

function makeSupervisor(idleEvictionMinutes: number | "off" = 90): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-eviction-drain-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.stopWorker = vi.fn(async (worker: WorkerFixture) => {
		supervisor.workers.delete(worker.descriptor.workerId);
	});
	supervisor.log = vi.fn();
	return supervisor;
}

describe("daemon supervisor idle eviction mutation drain (#1616)", () => {
	it("evicts an idle worker despite a stale mutation that never ends, and logs which mutation it bypassed", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);
		// A mutating command began 60s ago and never completed (hung or long-running turn).
		supervisor.mutationDrain.begin({ type: "prompt_and_wait", id: "cmd-7", clientId: "client-1" }, now - 60_000);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.workers.has("idle")).toBe(false);
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringMatching(/prompt_and_wait.*cmd-7|cmd-7.*prompt_and_wait/),
		);
	});

	it("resolves the sweep without draining when no worker is an eviction candidate", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const busy = makeWorker("busy", [makeSummary("busy-root", now, { isSessionActive: true })]);
		supervisor.workers.set("busy", busy);
		// A long-lived mutation is in flight on the busy worker (a running turn).
		supervisor.mutationDrain.begin({ type: "send_message", id: "cmd-long" }, now - 120_000);

		await expect(supervisor.runIdleEvictionSweep(now)).resolves.toBeUndefined();

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.has("busy")).toBe(true);
	});

	it("still waits bounded for a fresh mutation to finish before evicting", async () => {
		const now = Date.now();
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);
		const token = supervisor.mutationDrain.begin({ type: "rename", id: "cmd-quick" });

		const sweep = supervisor.runIdleEvictionSweep(now);
		// Give the sweep a moment to reach the drain, then complete the mutation.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		supervisor.mutationDrain.end(token);

		await sweep;
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
	});

	it("proceeds with eviction and logs the diagnosis when the drain window expires", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);
		supervisor.mutationDrain.begin({ type: "prompt", id: "cmd-fresh", clientId: "client-2" }, now - 500);
		const drainSpy = vi
			.spyOn(supervisor.mutationDrain, "waitForDrain")
			.mockRejectedValueOnce(new Error("Timed out draining daemon mutations for idle eviction"));

		await supervisor.runIdleEvictionSweep(now);

		expect(drainSpy).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("Timed out draining daemon mutations"));
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringMatching(/prompt.*cmd-fresh|cmd-fresh.*prompt/));
	});
});
