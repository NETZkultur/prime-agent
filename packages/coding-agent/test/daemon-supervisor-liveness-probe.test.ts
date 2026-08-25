import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import * as supervisorModule from "../src/modes/daemon/daemon-supervisor.js";

const { DaemonSupervisor } = supervisorModule;

interface LivenessProbeConfig {
	intervalMs: number;
	timeoutMs: number;
	retries: number;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
		lastError?: string;
		lastFailureAt?: string;
		createCommand: { type: "create"; config?: { sessionDir?: string } };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	recovery?: Promise<void>;
	updateRestartPrepareClient?: object;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	shuttingDown: boolean;
	updateRestartPhase?: string;
	workerLivenessProbeTimer?: { unref(): void };
	workerLivenessProbes: Set<WorkerFixture>;
	recoverWorker: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	syncAgentPeers: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	scheduleWorkerLivenessProbe(): void;
	clearWorkerLivenessProbeTimer(): void;
	runWorkerLivenessProbeSweep(config?: LivenessProbeConfig): Promise<void>;
}

const ENV_KEYS = [
	"PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS",
	"PRIME_DAEMON_WORKER_LIVENESS_TIMEOUT_MS",
	"PRIME_DAEMON_WORKER_LIVENESS_RETRIES",
] as const;
const FAST_PROBE: LivenessProbeConfig = { intervalMs: 60_000, timeoutMs: 40, retries: 2 };

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, now: number): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date(now).toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function makeWorker(id: string, summaries: SessionSummary[] = []): WorkerFixture {
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

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-liveness-"));
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
	supervisor.log = vi.fn();
	return supervisor;
}

describe("daemon supervisor worker liveness probe config", () => {
	it("uses conservative defaults", () => {
		expect(supervisorModule.workerLivenessProbeConfig({})).toEqual({
			intervalMs: 60_000,
			timeoutMs: 5_000,
			retries: 2,
		});
	});

	it("reads cadence and budget from the environment and disables on interval 0", () => {
		expect(
			supervisorModule.workerLivenessProbeConfig({
				PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS: "5000",
				PRIME_DAEMON_WORKER_LIVENESS_TIMEOUT_MS: "250",
				PRIME_DAEMON_WORKER_LIVENESS_RETRIES: "4",
			}),
		).toEqual({ intervalMs: 5000, timeoutMs: 250, retries: 4 });
		expect(
			supervisorModule.workerLivenessProbeConfig({ PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS: "0" }),
		).toMatchObject({ intervalMs: 0 });
	});

	it("falls back to defaults for invalid values", () => {
		expect(
			supervisorModule.workerLivenessProbeConfig({
				PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS: "soon",
				PRIME_DAEMON_WORKER_LIVENESS_TIMEOUT_MS: "-5",
				PRIME_DAEMON_WORKER_LIVENESS_RETRIES: "many",
			}),
		).toEqual({ intervalMs: 60_000, timeoutMs: 5_000, retries: 2 });
	});
});

describe("daemon supervisor worker liveness probe sweep", () => {
	it("marks a wedged connected worker failed and hands it to recovery exactly once", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWorker("wedged", [makeSummary("wedged-root", Date.now())]);
		const wedgedClient = wedged.client!;
		wedgedClient.request.mockImplementation(() => new Promise(() => {}));
		supervisor.workers.set("wedged", wedged);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(wedgedClient.request).toHaveBeenCalledTimes(3);
		expect(wedgedClient.close).toHaveBeenCalled();
		expect(wedged.client).toBeUndefined();
		expect(wedged.descriptor.lifecycle).toBe("failed");
		expect(wedged.descriptor.lastError).toMatch(/Liveness probe failed after 3 attempt/);
		expect(wedged.descriptor.lastFailureAt).toBeTruthy();
		expect(supervisor.persistWorker).toHaveBeenCalledWith(wedged);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.recoverWorker).toHaveBeenCalledWith(wedged);
	});

	it("does not re-fail or re-recover an already failed worker on the next sweep", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWorker("wedged", [makeSummary("wedged-root", Date.now())]);
		const wedgedClient = wedged.client!;
		wedgedClient.request.mockImplementation(() => new Promise(() => {}));
		supervisor.workers.set("wedged", wedged);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(wedgedClient.request).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("skips a worker that is already recovering", async () => {
		const supervisor = makeSupervisor();
		const recovering = makeWorker("recovering", [makeSummary("recovering-root", Date.now())]);
		recovering.recovery = Promise.resolve();
		supervisor.workers.set("recovering", recovering);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(recovering.client!.request).not.toHaveBeenCalled();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});

	it("never fails a healthy worker and absorbs one transient probe failure", async () => {
		const supervisor = makeSupervisor();
		const healthy = makeWorker("healthy", [makeSummary("healthy-root", Date.now())]);
		let calls = 0;
		healthy.client!.request.mockImplementation(async () => {
			calls += 1;
			if (calls === 1) {
				throw new Error("Timed out waiting for daemon worker response to list");
			}
			return success(undefined, "list", { sessions: [] });
		});
		supervisor.workers.set("healthy", healthy);

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(healthy.client!.request).toHaveBeenCalledTimes(2);
		expect(healthy.descriptor.lifecycle).toBe("ready");
		expect(healthy.client!.close).not.toHaveBeenCalled();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});

	it("skips workers that are not connected, not ready, stopping, or absent from the map", async () => {
		const supervisor = makeSupervisor();
		const disconnected = makeWorker("disconnected");
		const disconnectedClient = disconnected.client!;
		disconnected.client = undefined;
		const recovering = makeWorker("lifecycle-recovering");
		recovering.descriptor.lifecycle = "recovering";
		const stopping = makeWorker("stopping");
		stopping.descriptor.stopRequestedAt = new Date().toISOString();
		const orphaned = makeWorker("orphaned");
		supervisor.workers.set("disconnected", disconnected);
		supervisor.workers.set("lifecycle-recovering", recovering);
		supervisor.workers.set("stopping", stopping);
		// orphaned is deliberately not registered in supervisor.workers

		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);

		expect(disconnectedClient.request).not.toHaveBeenCalled();
		expect(recovering.client?.request).not.toHaveBeenCalled();
		expect(stopping.client?.request).not.toHaveBeenCalled();
		expect(orphaned.client?.request).not.toHaveBeenCalled();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});

	it("does not probe while shutting down or during an update restart", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("worker", [makeSummary("worker-root", Date.now())]);
		supervisor.workers.set("worker", worker);

		supervisor.shuttingDown = true;
		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		expect(worker.client!.request).not.toHaveBeenCalled();

		supervisor.shuttingDown = false;
		supervisor.updateRestartPhase = "prepare";
		await supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		expect(worker.client!.request).not.toHaveBeenCalled();
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});

	it("does not double-probe a worker across overlapping sweeps", async () => {
		const supervisor = makeSupervisor();
		const wedged = makeWorker("wedged", [makeSummary("wedged-root", Date.now())]);
		const wedgedClient = wedged.client!;
		wedgedClient.request.mockImplementation(() => new Promise(() => {}));
		supervisor.workers.set("wedged", wedged);

		const first = supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		const second = supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		await Promise.all([first, second]);

		expect(wedgedClient.request).toHaveBeenCalledTimes(3);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("reads the probe budget from the environment when no override is passed", async () => {
		process.env.PRIME_DAEMON_WORKER_LIVENESS_TIMEOUT_MS = "30";
		process.env.PRIME_DAEMON_WORKER_LIVENESS_RETRIES = "1";
		const supervisor = makeSupervisor();
		const wedged = makeWorker("wedged", [makeSummary("wedged-root", Date.now())]);
		const wedgedClient = wedged.client!;
		wedgedClient.request.mockImplementation(() => new Promise(() => {}));
		supervisor.workers.set("wedged", wedged);

		await supervisor.runWorkerLivenessProbeSweep();

		expect(wedgedClient.request).toHaveBeenCalledTimes(2);
		expect(wedged.descriptor.lastError).toMatch(/Liveness probe failed after 2 attempt/);
		expect(supervisor.recoverWorker).toHaveBeenCalledTimes(1);
	});

	it("aborts an in-flight probe instead of failing the worker when conditions change", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("worker", [makeSummary("worker-root", Date.now())]);
		let releaseProbe!: (value: ReturnType<typeof success>) => void;
		worker.client!.request.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseProbe = resolve;
				}),
		);
		supervisor.workers.set("worker", worker);

		const sweep = supervisor.runWorkerLivenessProbeSweep(FAST_PROBE);
		await vi.waitFor(() => expect(worker.client!.request).toHaveBeenCalledOnce());
		supervisor.shuttingDown = true;
		releaseProbe(success(undefined, "list", { sessions: [] }));
		await sweep;

		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});
});

describe("daemon supervisor worker liveness probe scheduling", () => {
	it("does not schedule a timer when the interval is disabled", () => {
		process.env.PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS = "0";
		const supervisor = makeSupervisor();
		supervisor.scheduleWorkerLivenessProbe();
		expect(supervisor.workerLivenessProbeTimer).toBeUndefined();
	});

	it("schedules an unref timer and clears it again", () => {
		process.env.PRIME_DAEMON_WORKER_LIVENESS_INTERVAL_MS = "100000";
		const supervisor = makeSupervisor();
		supervisor.scheduleWorkerLivenessProbe();
		expect(supervisor.workerLivenessProbeTimer).toBeDefined();
		supervisor.clearWorkerLivenessProbeTimer();
		expect(supervisor.workerLivenessProbeTimer).toBeUndefined();
		supervisor.clearWorkerLivenessProbeTimer();
		expect(supervisor.workerLivenessProbeTimer).toBeUndefined();
	});
});
