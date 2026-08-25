import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureWedgedWorkerDiagnostics,
	readWedgedWorkerDiagnostics,
} from "../src/modes/daemon/wedged-worker-diagnostics.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-wedge-diagnostics-"));
	tempDirs.push(directory);
	return directory;
}

describe("wedged worker diagnostics", () => {
	it("captures a durable record for the wedged worker naming pid, reason and process state", () => {
		const path = join(makeDir(), "worker-a.wedge.jsonl");

		captureWedgedWorkerDiagnostics(path, {
			workerId: "worker-a",
			rootActiveSessionId: "session-a",
			pid: process.pid,
			reason: "Liveness probe failed after 3 attempt(s)",
		});

		const records = readWedgedWorkerDiagnostics(path);
		expect(records).toHaveLength(1);
		const record = records[0]!;
		expect(record).toMatchObject({
			version: 1,
			workerId: "worker-a",
			rootActiveSessionId: "session-a",
			pid: process.pid,
			reason: "Liveness probe failed after 3 attempt(s)",
		});
		expect(typeof record.recordedAt).toBe("string");
		// The whole point of the capture: what the wedged process was doing.
		expect(record.process).toBeDefined();
		expect(record.process?.state).toBeTruthy();
		expect(Array.isArray(record.threads)).toBe(true);
	});

	it("appends successive wedge events instead of overwriting them", () => {
		const path = join(makeDir(), "worker-b.wedge.jsonl");

		captureWedgedWorkerDiagnostics(path, {
			workerId: "worker-b",
			rootActiveSessionId: "session-b",
			pid: process.pid,
			reason: "first wedge",
		});
		captureWedgedWorkerDiagnostics(path, {
			workerId: "worker-b",
			rootActiveSessionId: "session-b",
			pid: process.pid,
			reason: "second wedge",
		});

		const records = readWedgedWorkerDiagnostics(path);
		expect(records.map((record) => record.reason)).toEqual(["first wedge", "second wedge"]);
	});

	it("never throws for a dead pid and still records the reason", () => {
		const path = join(makeDir(), "worker-c.wedge.jsonl");

		expect(() =>
			captureWedgedWorkerDiagnostics(path, {
				workerId: "worker-c",
				rootActiveSessionId: "session-c",
				// Very unlikely to exist; the capture must degrade, not throw.
				pid: 2 ** 22 - 1,
				reason: "dead pid",
			}),
		).not.toThrow();

		const records = readWedgedWorkerDiagnostics(path);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ workerId: "worker-c", reason: "dead pid" });
	});

	it("never throws when the target directory cannot be written", () => {
		expect(() =>
			captureWedgedWorkerDiagnostics("/proc/definitely-not-writable/worker.wedge.jsonl", {
				workerId: "worker-d",
				rootActiveSessionId: "session-d",
				pid: process.pid,
				reason: "unwritable",
			}),
		).not.toThrow();
	});

	it("bounds the journal so repeated wedges cannot grow it without limit", () => {
		const path = join(makeDir(), "worker-e.wedge.jsonl");

		for (let index = 0; index < 40; index += 1) {
			captureWedgedWorkerDiagnostics(path, {
				workerId: "worker-e",
				rootActiveSessionId: "session-e",
				pid: process.pid,
				reason: `wedge ${index}`,
			});
		}

		const records = readWedgedWorkerDiagnostics(path);
		expect(records.length).toBeLessThanOrEqual(20);
		// The most recent wedge must always survive the trim.
		expect(records.at(-1)?.reason).toBe("wedge 39");
	});

	it("skips malformed lines instead of failing the read", () => {
		const path = join(makeDir(), "worker-f.wedge.jsonl");
		writeFileSync(path, `not json\n${JSON.stringify({ version: 1, workerId: "worker-f", reason: "kept" })}\n`);

		const records = readWedgedWorkerDiagnostics(path);
		expect(records).toHaveLength(1);
		expect(records[0]?.reason).toBe("kept");
	});

	it("writes one JSON object per line", () => {
		const path = join(makeDir(), "worker-g.wedge.jsonl");
		captureWedgedWorkerDiagnostics(path, {
			workerId: "worker-g",
			rootActiveSessionId: "session-g",
			pid: process.pid,
			reason: "line shape",
		});

		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(() => JSON.parse(lines[0]!)).not.toThrow();
	});
});
