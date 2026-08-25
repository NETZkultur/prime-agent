import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import * as supervisorModule from "../src/modes/daemon/daemon-supervisor.js";

const { DaemonSupervisor } = supervisorModule;

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
		createCommand: { type: "create"; config?: { sessionDir?: string } };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, unknown>;
	snapshotLoads: Map<string, unknown>;
	transcriptCaches: Map<string, unknown>;
	snapshotGenerations?: Map<string, unknown>;
	intentionalStop: boolean;
	recovery?: Promise<void>;
}

interface ClientFixture {
	id: string;
	attachedActiveSessionIds: Set<string>;
	catchupActiveSessionIds?: Set<string>;
	catchupPurposes?: Map<string, "replacement" | "resync">;
	socket: { destroyed: boolean; write: ReturnType<typeof vi.fn> };
	capabilities: Set<string>;
	supportsExtensionUi: boolean;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<ClientFixture>;
	shuttingDown: boolean;
	recoverWorker: ReturnType<typeof vi.fn>;
	persistWorker: ReturnType<typeof vi.fn>;
	syncAgentPeers: ReturnType<typeof vi.fn>;
	catchUpClient: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	broadcastWorkerRespawned(worker: WorkerFixture, reason: string): void;
	waitForWorkerRecovery(worker: WorkerFixture, deadlineMs?: number): Promise<void>;
	forwardToWorker(worker: WorkerFixture, command: unknown, timeoutMs?: number): Promise<unknown>;
	workerRecoveryWaiters: Map<unknown, number>;
}

const tempDirs: string[] = [];
const RECOVERY_WAIT_ENV = "PRIME_DAEMON_WORKER_RECOVERY_WAIT_MS";
let savedRecoveryWait: string | undefined;

beforeEach(() => {
	savedRecoveryWait = process.env[RECOVERY_WAIT_ENV];
	// Keep the parking budget far below the vitest timeout: these tests assert
	// the bound itself, not the production 45s budget.
	process.env[RECOVERY_WAIT_ENV] = "300";
});

afterEach(() => {
	if (savedRecoveryWait === undefined) {
		delete process.env[RECOVERY_WAIT_ENV];
	} else {
		process.env[RECOVERY_WAIT_ENV] = savedRecoveryWait;
	}
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
	};
}

function makeWorker(id: string, summaries: SessionSummary[] = []): WorkerFixture {
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: summaries[0]?.activeSessionId ?? `${id}-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client: {
			request: vi.fn(async () => success(undefined, "prompt", undefined)),
			requestWorker: vi.fn(),
			close: vi.fn(),
		},
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		snapshotCache: new Map(),
		snapshotLoads: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		intentionalStop: false,
	};
}

function makeClient(id: string, attached: string[]): ClientFixture {
	return {
		id,
		attachedActiveSessionIds: new Set(attached),
		socket: { destroyed: false, write: vi.fn(() => true) },
		capabilities: new Set<string>(),
		supportsExtensionUi: false,
	};
}

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-recovery-"));
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
	supervisor.catchUpClient = vi.fn(async () => undefined);
	supervisor.log = vi.fn();
	supervisor.write = vi.fn(() => true);
	return supervisor;
}

// B1: a respawned worker must reattach the clients that were attached to the
// dead process, not only announce the respawn.
describe("worker respawn client reattach (INC-0092 B1)", () => {
	it("queues a replacement catch-up for every client attached to the respawned worker", () => {
		const supervisor = makeSupervisor();
		const summary = makeSummary("live-root");
		const worker = makeWorker("w1", [summary]);
		supervisor.workers.set("w1", worker);
		const attached = makeClient("client-attached", ["live-root"]);
		const other = makeClient("client-other", ["different-session"]);
		supervisor.clients.add(attached);
		supervisor.clients.add(other);

		supervisor.broadcastWorkerRespawned(worker, "worker_recovery");

		expect([...(attached.catchupActiveSessionIds ?? [])]).toEqual(["live-root"]);
		expect(attached.catchupPurposes?.get("live-root")).toBe("replacement");
		expect(supervisor.catchUpClient).toHaveBeenCalledWith(attached);
		expect(other.catchupActiveSessionIds ?? new Set()).toEqual(new Set());
		expect(supervisor.catchUpClient).not.toHaveBeenCalledWith(other);
	});

	it("still emits the worker_respawned event to all clients", () => {
		const supervisor = makeSupervisor();
		const summary = makeSummary("live-root");
		const worker = makeWorker("w1", [summary]);
		supervisor.workers.set("w1", worker);
		const attached = makeClient("client-attached", ["live-root"]);
		supervisor.clients.add(attached);

		supervisor.broadcastWorkerRespawned(worker, "worker_recovery");

		expect(supervisor.write).toHaveBeenCalledWith(
			attached,
			expect.objectContaining({ type: "worker_respawned", workerId: "w1", activeSessionId: "live-root" }),
		);
	});
});

// B2: a prompt that arrives while the worker is failed/recovering must reach
// the recovered worker instead of being rejected.
describe("prompt routing across worker recovery (INC-0092 B2)", () => {
	it("waits for an in-flight recovery and forwards the prompt to the recovered worker", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		// Wedged: probe dropped the client and marked the worker failed.
		const deadClient = worker.client!;
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		let finishRecovery: () => void = () => {};
		worker.recovery = new Promise<void>((resolve) => {
			finishRecovery = () => {
				worker.client = {
					request: vi.fn(async () => success(undefined, "prompt", { ok: true })),
					requestWorker: vi.fn(),
					close: vi.fn(),
				};
				worker.descriptor.lifecycle = "ready";
				worker.recovery = undefined;
				resolve();
			};
		});
		setTimeout(finishRecovery, 20).unref();

		const response = (await supervisor.forwardToWorker(worker, {
			id: "cmd-1",
			type: "prompt",
			activeSessionId: "live-root",
			text: "hello",
		})) as { success: boolean };

		expect(response.success).toBe(true);
		expect(worker.client!.request).toHaveBeenCalled();
		expect(deadClient.request).not.toHaveBeenCalled();
	});

	it("starts recovery for an eligible failed worker instead of rejecting the prompt", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		supervisor.recoverWorker = vi.fn(async () => {
			worker.client = {
				request: vi.fn(async () => success(undefined, "prompt", { ok: true })),
				requestWorker: vi.fn(),
				close: vi.fn(),
			};
			worker.descriptor.lifecycle = "ready";
		});

		const response = (await supervisor.forwardToWorker(worker, {
			id: "cmd-2",
			type: "prompt",
			activeSessionId: "live-root",
			text: "hello",
		})) as { success: boolean };

		expect(supervisor.recoverWorker).toHaveBeenCalledWith(worker);
		expect(response.success).toBe(true);
	});

	it("rejects promptly when recovery does not make the worker available", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		worker.recovery = new Promise<void>(() => {});

		await expect(
			supervisor.forwardToWorker(
				worker,
				{ id: "cmd-3", type: "prompt", activeSessionId: "live-root", text: "hi" },
				undefined,
			),
		).rejects.toThrow(/Session worker is (failed|recovering)/);
	});

	it("does not wait for a stopping worker", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		worker.intentionalStop = true;

		const started = Date.now();
		await expect(
			supervisor.forwardToWorker(worker, { id: "cmd-4", type: "prompt", activeSessionId: "live-root", text: "hi" }),
		).rejects.toThrow(/Session worker is stopping/);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(supervisor.recoverWorker).not.toHaveBeenCalled();
	});

	it("does not delay non-prompt commands behind recovery", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		worker.recovery = new Promise<void>(() => {});

		const started = Date.now();
		await expect(
			supervisor.forwardToWorker(worker, { id: "cmd-5", type: "get_state", activeSessionId: "live-root" }),
		).rejects.toThrow(/Session worker is failed/);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("bounds the number of commands parked on one recovering worker", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("w1", [makeSummary("live-root")]);
		supervisor.workers.set("w1", worker);
		worker.client = undefined;
		worker.descriptor.lifecycle = "failed";
		worker.recovery = new Promise<void>(() => {});

		const attempts = Array.from({ length: supervisorModule.WORKER_RECOVERY_WAIT_MAX_WAITERS + 5 }, (_, index) =>
			supervisor
				.forwardToWorker(worker, { id: `cmd-${index}`, type: "prompt", activeSessionId: "live-root", text: "hi" })
				.then(
					() => "resolved",
					(error: Error) => error.message,
				),
		);
		const results = await Promise.all(attempts);
		const rejectedForCapacity = results.filter((message) => /too many/i.test(String(message)));
		expect(rejectedForCapacity.length).toBeGreaterThanOrEqual(5);
	});
});
