import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DAEMON_WORKER_STARTUP_GATE_COMMIT } from "../src/modes/daemon/daemon-worker-protocol.js";

const workerRespawnTestState = vi.hoisted(() => ({
	capture: false,
	forceMissingProcessStartId: false,
	fixtureMode: "worker" as "worker" | "successful-gate",
	gateMarkerPath: "",
	spawned: [] as Array<{ child: ChildProcess; args: readonly string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
	};
	return {
		...actual,
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
			const child = actual.spawn(command, args, options);
			if (workerRespawnTestState.capture) {
				workerRespawnTestState.spawned.push({ child, args });
			}
			return child;
		},
	};
});

vi.mock("../src/cli/subprocess-launch.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createCliSubprocessLaunchSpec(args: readonly string[]) {
			if (!workerRespawnTestState.capture) {
				return (actual.createCliSubprocessLaunchSpec as (args: readonly string[]) => unknown)(args);
			}
			const markerPath = JSON.stringify(workerRespawnTestState.gateMarkerPath);
			const commitMarker = JSON.stringify(DAEMON_WORKER_STARTUP_GATE_COMMIT);
			return {
				command: process.execPath,
				args: [
					"--eval",
					`const fs = require("node:fs"); const marker = fs.readFileSync(3, "utf8"); if (marker === ${commitMarker}) { fs.writeFileSync(${markerPath}, marker); setInterval(() => {}, 1000); }`,
					"--",
					...args,
				],
			};
		},
	};
});

vi.mock("../src/core/session-lease.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown> & {
		getProcessStartId(pid: number): string | undefined;
	};
	return {
		...actual,
		getProcessStartId(pid: number): string | undefined {
			return workerRespawnTestState.forceMissingProcessStartId ? undefined : actual.getProcessStartId(pid);
		},
	};
});

const tempDirs: string[] = [];

afterEach(async () => {
	for (const { child } of workerRespawnTestState.spawned) {
		if (child.exitCode === null && child.signalCode === null) {
			const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose));
			child.kill("SIGKILL");
			// The fixture child is killed and reaped (signalCode set), but the
			// supervisor-side stdio plumbing can swallow the "close" event, so the
			// wait is bounded instead of open-ended.
			for (const stream of child.stdio) stream?.destroy?.();
			await Promise.race([closed, new Promise((resolveDelay) => setTimeout(resolveDelay, 300))]);
		}
	}
	workerRespawnTestState.capture = false;
	workerRespawnTestState.forceMissingProcessStartId = false;
	workerRespawnTestState.fixtureMode = "worker";
	workerRespawnTestState.gateMarkerPath = "";
	workerRespawnTestState.spawned.length = 0;
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

interface LaunchWorkerFixture {
	descriptor: {
		workerId: string;
		pid: number;
		rootActiveSessionId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		createCommand: { type: "create"; config?: { cwd?: string; agentDir?: string } };
		ownerClientId?: string;
		consecutiveFailures: number;
	};
	descriptorPath: string;
	summaries: Map<string, unknown>;
	snapshotCache: Map<string, unknown>;
	transcriptCaches: Map<string, unknown>;
	snapshotGenerations: Map<string, unknown>;
	snapshotLoads: Map<string, unknown>;
	intentionalStop: boolean;
	stopRevision: number;
}

function createExistingLaunchWorker(root: string, descriptorDir: string): LaunchWorkerFixture {
	const workerId = "existing-worker";
	const now = new Date().toISOString();
	return {
		descriptor: {
			workerId,
			pid: 999_999,
			socketPath: join(root, `${workerId}.sock`),
			rootActiveSessionId: "existing-root-session",
			createdAt: now,
			updatedAt: now,
			lifecycle: "recovering",
			createCommand: { type: "create", config: { cwd: root, agentDir: root } },
			consecutiveFailures: 1,
		},
		descriptorPath: join(descriptorDir, `${workerId}.json`),
		summaries: new Map(),
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	} as LaunchWorkerFixture;
}

interface RespawnHarness {
	launchWorker(
		command: { type: "create"; config: { cwd: string; agentDir: string } },
		existing?: LaunchWorkerFixture,
		ownerClientId?: string,
	): Promise<LaunchWorkerFixture>;
	write: ReturnType<typeof vi.fn>;
}

function makeRespawnHarness(
	root: string,
	descriptorDir: string,
	markerPath: string,
	clients: Set<object>,
	existing?: LaunchWorkerFixture,
): {
	supervisor: RespawnHarness;
	write: ReturnType<typeof vi.fn>;
} {
	const write = vi.fn(() => true);
	const connectWorker = vi.fn(async (worker: { descriptor: { rootActiveSessionId: string } }) => {
		await waitForFile(markerPath);
		return {
			request: vi.fn(async () => ({
				success: true,
				data: {
					id: worker.descriptor.rootActiveSessionId,
					activeSessionId: worker.descriptor.rootActiveSessionId,
					sessionId: "session-worker-respawn",
					cwd: root,
				},
			})),
		};
	});
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		clients,
		sessionInputPauses: new Map(),
		pendingReplacementSnapshots: new WeakMap(),
		defaultSessionConfig: { cwd: root, agentDir: root },
		descriptorDir,
		socketPath: join(root, "supervisor.sock"),
		workers: new Map<string, unknown>(existing ? [[existing.descriptor.workerId, existing]] : []),
		shuttingDown: false,
		assertRecoveryAllowed: vi.fn(async () => undefined),
		connectWorker,
		subscribeWorker: vi.fn(async () => undefined),
		refreshWorkerSummaries: vi.fn(async () => undefined),
		syncAgentPeers: vi.fn(async () => undefined),
		log: vi.fn(),
		write,
	}) as unknown as RespawnHarness;
	return { supervisor, write };
}

function respawnedWrites(write: ReturnType<typeof vi.fn>): DaemonOutbound[] {
	return write.mock.calls
		.map((call) => call[1] as DaemonOutbound)
		.filter((message) => message?.type === "worker_respawned");
}

describe("daemon supervisor worker respawn notification", () => {
	it("emits worker_respawned exactly once per client when recovering an existing worker", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-respawn-test-"));
		tempDirs.push(root);
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		workerRespawnTestState.capture = true;
		workerRespawnTestState.forceMissingProcessStartId = true;
		workerRespawnTestState.fixtureMode = "successful-gate";
		workerRespawnTestState.gateMarkerPath = markerPath;
		const clients = new Set([
			{ id: "client-a", attachedActiveSessionIds: new Set<string>() },
			{ id: "client-b", attachedActiveSessionIds: new Set<string>() },
		]);
		const existing = createExistingLaunchWorker(root, descriptorDir);
		const { supervisor, write } = makeRespawnHarness(root, descriptorDir, markerPath, clients, existing);

		const worker = await supervisor.launchWorker(
			{ type: "create", config: { cwd: root, agentDir: root } },
			existing,
			"client-a",
		);

		expect(worker.descriptor.lifecycle).toBe("ready");
		const respawned = respawnedWrites(write);
		expect(respawned).toHaveLength(2);
		for (const message of respawned) {
			expect(message).toMatchObject({
				type: "worker_respawned",
				workerId: "existing-worker",
				activeSessionId: "existing-root-session",
				sessionId: "session-worker-respawn",
				reason: "worker_recovery",
			});
			expect(Number.isNaN(Date.parse((message as { respawnedAt: string }).respawnedAt))).toBe(false);
		}
	});

	it("does not emit worker_respawned for a fresh worker launch", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-supervisor-fresh-launch-test-"));
		tempDirs.push(root);
		const descriptorDir = join(root, "descriptors");
		const markerPath = join(root, "startup-marker");
		mkdirSync(descriptorDir, { recursive: true });
		workerRespawnTestState.capture = true;
		workerRespawnTestState.forceMissingProcessStartId = true;
		workerRespawnTestState.fixtureMode = "successful-gate";
		workerRespawnTestState.gateMarkerPath = markerPath;
		const clients = new Set([{ id: "client-a", attachedActiveSessionIds: new Set<string>() }]);
		const { supervisor, write } = makeRespawnHarness(root, descriptorDir, markerPath, clients);

		const worker = await supervisor.launchWorker({ type: "create", config: { cwd: root, agentDir: root } });

		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(respawnedWrites(write)).toHaveLength(0);
	});
});
