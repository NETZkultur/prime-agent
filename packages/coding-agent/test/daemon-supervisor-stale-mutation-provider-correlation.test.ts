import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		pid: number;
		createCommand: { type: "create" };
	};
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
	mutationDrain: {
		begin(label: { type?: string; id?: string; clientId?: string; sessionId?: string }, startedAt?: number): unknown;
		activeMutations(
			now?: number,
		): Array<{ type?: string; id?: string; clientId?: string; sessionId?: string; ageMs: number }>;
	};
	refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
	persistWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	describeActiveMutationsWithWorkerState(
		mutations: Array<{ type?: string; id?: string; clientId?: string; sessionId?: string; ageMs: number }>,
	): Promise<string>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
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
		...overrides,
	} as SessionSummary;
}

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-mutation-correlation-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.persistWorker = vi.fn();
	supervisor.log = vi.fn();
	return supervisor;
}

function makeWorker(id: string, summaries: SessionSummary[]): WorkerFixture {
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: summaries[0]
				? (summaries[0].activeSessionId ?? summaries[0].id)
				: `${id}-descriptor-root`,
			pid: 1,
			createCommand: { type: "create" },
		},
		client: {
			request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
			requestWorker: vi.fn(),
			close: vi.fn(),
		},
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

describe("daemon supervisor stale mutation provider-call correlation", () => {
	it("correlates a stale mutation with live worker-side session state", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("worker-a", [
			makeSummary("sess-a", {
				activity: "working",
				isStreaming: true,
				isRunningTools: false,
				model: { provider: "openrouter", id: "test-model" } as SessionSummary["model"],
			}),
		]);
		supervisor.workers.set("worker-a", worker);
		supervisor.mutationDrain.begin({ type: "prompt_and_wait", sessionId: "sess-a" }, Date.now() - 10_000);

		const description = await supervisor.describeActiveMutationsWithWorkerState(
			supervisor.mutationDrain.activeMutations(),
		);

		expect(description).toMatch(/type=prompt_and_wait/);
		expect(description).toMatch(/workerState=responsive/);
		expect(description).toMatch(/activity=working/);
		expect(description).toMatch(/streaming=true/);
		expect(description).toMatch(/runningTools=false/);
		expect(description).toMatch(/model=openrouter\/test-model/);
	});

	it("reports an unresponsive worker when the diagnosis refresh fails", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorker("worker-a", [makeSummary("sess-a")]);
		supervisor.workers.set("worker-a", worker);
		supervisor.refreshWorkerSummaries = vi.fn(async () => {
			throw new Error("Timed out waiting for daemon worker response to list");
		});
		supervisor.mutationDrain.begin({ type: "prompt_and_wait", sessionId: "sess-a" }, Date.now() - 10_000);

		const description = await supervisor.describeActiveMutationsWithWorkerState(
			supervisor.mutationDrain.activeMutations(),
		);

		expect(description).toMatch(/workerState=unresponsive/);
	});

	it("reports unknown worker state for mutations without a resident session", async () => {
		const supervisor = makeSupervisor();
		supervisor.mutationDrain.begin({ type: "prompt_and_wait", sessionId: "nope" }, Date.now() - 10_000);

		const description = await supervisor.describeActiveMutationsWithWorkerState(
			supervisor.mutationDrain.activeMutations(),
		);

		expect(description).toMatch(/workerState=unknown/);
	});
});
