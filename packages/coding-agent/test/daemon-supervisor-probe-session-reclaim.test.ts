import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

// Simulated worker process 4242: alive until the supervisor kills it with a
// verified identity, exactly like a real wedged process would be.
const procState = vi.hoisted(() => ({
	alive: true,
	killed: 0,
	startId: "start-4242",
}));

vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		isProcessAlive: (pid: number) => pid === 4242 && procState.alive,
		signalProcessGroupOrProcess: (pid: number, signal: string) => {
			if (pid === 4242 && signal === "SIGKILL") {
				procState.alive = false;
				procState.killed += 1;
			}
		},
	};
});

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getProcessStartId: (pid: number) => (pid === 4242 && procState.alive ? procState.startId : undefined),
	};
});

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		sessionFile: string;
		pid: number;
		processStartId?: string;
		ownerClientId?: string;
		lastError?: string;
		lastFailureAt?: string;
		createCommand: { type: "create" };
	};
	descriptorPath: string;
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	recoverWorker: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	syncAgentPeers: ReturnType<typeof vi.fn>;
	recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
	invalidateWorkerSessionInputPauses: ReturnType<typeof vi.fn>;
	deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	runWorkerLivenessProbeSweep(config?: { intervalMs: number; timeoutMs: number; retries: number }): Promise<void>;
	reclaimStaleWorkerRegistration(worker: WorkerFixture, freshCreate?: boolean): Promise<boolean>;
}

const FAST_PROBE = { intervalMs: 60_000, timeoutMs: 40, retries: 2 };
const tempDirs: string[] = [];

beforeEach(() => {
	procState.alive = true;
	procState.killed = 0;
});

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date().toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	} as SessionSummary;
}

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-probe-reclaim-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.recoverWorker = vi.fn(async () => undefined);
	supervisor.persistWorker = vi.fn();
	supervisor.syncAgentPeers = vi.fn(async () => undefined);
	supervisor.recoverUncertainWorkerOperations = vi.fn(async () => undefined);
	supervisor.invalidateWorkerSessionInputPauses = vi.fn();
	supervisor.deleteWorkerDescriptor = vi.fn();
	supervisor.log = vi.fn();
	return supervisor;
}

function makeWedgedWorker(id: string, overrides: Partial<WorkerFixture["descriptor"]> = {}): WorkerFixture {
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-root`,
			rootSessionId: `${id}-session-id`,
			sessionFile: `/tmp/sessions/${id}.jsonl`,
			pid: 4242,
			processStartId: procState.startId,
			createCommand: { type: "create" },
			...overrides,
		},
		descriptorPath: `/tmp/descriptors/${id}.json`,
		client: {
			request: vi.fn(() => new Promise(() => {})),
			requestWorker: vi.fn(),
			close: vi.fn(),
		},
		summaries: new Map([[`${id}-root`, makeSummary(`${id}-root`)]]),
		intentionalStop: false,
	};
}

describe("daemon supervisor liveness probe session reclaimability", () => {
	it("keeps the wedged worker's session file reclaimable after marking it failed", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWedgedWorker("wedged");
		supervisor.workers.set("wedged", wedged);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(wedged.descriptor.lifecycle).toBe("failed");
		expect(wedged.client).toBeUndefined();
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
		// The wedged process must not survive as a live-but-failed registration:
		// that is exactly the "could not be safely reclaimed" lockout class.
		expect(procState.killed).toBe(1);

		// A resume without fresh runtime context (launchEnv) must still reclaim
		// the registration and let a fresh worker open the session file.
		const reclaimed = await supervisor.reclaimStaleWorkerRegistration(wedged, false);
		expect(reclaimed).toBe(true);
		expect(supervisor.workers.has("wedged")).toBe(false);
		expect(supervisor.recoverUncertainWorkerOperations).toHaveBeenCalledWith(wedged, false);
		expect(supervisor.deleteWorkerDescriptor).toHaveBeenCalledWith(wedged);
	});

	it("never kills a wedged worker whose process identity is unverifiable", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWedgedWorker("unverified", { processStartId: undefined });
		supervisor.workers.set("unverified", wedged);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(wedged.descriptor.lifecycle).toBe("failed");
		expect(procState.killed).toBe(0);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("also reclaims an owner-client wedged worker registration after the kill", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWedgedWorker("owned", { ownerClientId: "client-a" });
		supervisor.workers.set("owned", wedged);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(procState.killed).toBe(1);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
		// The kill already ran; the resume path must not be wedged behind a
		// live-but-failed registration even when it carries no launchEnv.
		supervisor.recoverWorker.mockClear();
		const reclaimed = await supervisor.reclaimStaleWorkerRegistration(wedged, false);
		// Owner-client registrations are reclaimed through the owning-client flow,
		// not through this path; the kill still removed the live lockout.
		expect(reclaimed).toBe(false);
		expect(procState.alive).toBe(false);
	});
});
