import { appendFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Diagnostics captured at the moment a worker is declared wedged.
 *
 * The liveness probe can prove that a worker stopped answering, but by the
 * time anyone reads the daemon log the wedged process has already been killed
 * and replaced, so the evidence for WHY it wedged is gone (INC-0092 root-cause
 * hunt). This records the cheap, always-available kernel-level facts about the
 * process before it is killed.
 *
 * Capture is strictly best-effort: it must never throw, never block, and never
 * delay the recovery it is observing. A missing or unreadable field is recorded
 * as absent rather than raised.
 */
export interface WedgedWorkerDiagnosticsRecord {
	version: 1;
	workerId: string;
	rootActiveSessionId?: string;
	pid: number;
	reason: string;
	recordedAt: string;
	process?: {
		/** Linux process state letter, e.g. "R" running, "S" sleeping, "D" uninterruptible. */
		state?: string;
		/** Kernel symbol the task is blocked in, the strongest signal for a blocking syscall. */
		wchan?: string;
		threadCount?: number;
		voluntaryCtxtSwitches?: number;
		nonvoluntaryCtxtSwitches?: number;
		vmRssKb?: number;
		openFileDescriptors?: number;
	};
	/** Per-thread state, so a wedge in one thread is distinguishable from a whole-process stall. */
	threads?: { tid: number; state?: string; wchan?: string }[];
}

export interface WedgedWorkerDiagnosticsInput {
	workerId: string;
	rootActiveSessionId?: string;
	pid: number;
	reason: string;
}

/** Keep the newest wedge events only; a flapping worker must not grow this file without bound. */
const MAX_WEDGE_RECORDS = 20;
const MAX_THREADS_RECORDED = 16;

function readTextOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseStatusNumber(status: string | undefined, field: string): number | undefined {
	if (!status) return undefined;
	const match = new RegExp(`^${field}:\\s*(\\d+)`, "m").exec(status);
	return match ? Number(match[1]) : undefined;
}

/** The state letter lives in /proc/<pid>/stat after the comm field, which may itself contain spaces. */
function parseStatState(stat: string | undefined): string | undefined {
	if (!stat) return undefined;
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const rest = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	return rest[0] || undefined;
}

function collectProcessFacts(pid: number): WedgedWorkerDiagnosticsRecord["process"] {
	const status = readTextOrUndefined(`/proc/${pid}/status`);
	const stat = readTextOrUndefined(`/proc/${pid}/stat`);
	const wchan = readTextOrUndefined(`/proc/${pid}/wchan`)?.trim();
	let openFileDescriptors: number | undefined;
	try {
		openFileDescriptors = readdirSync(`/proc/${pid}/fd`).length;
	} catch {
		openFileDescriptors = undefined;
	}
	const facts = {
		state: parseStatState(stat),
		...(wchan ? { wchan } : {}),
		threadCount: parseStatusNumber(status, "Threads"),
		voluntaryCtxtSwitches: parseStatusNumber(status, "voluntary_ctxt_switches"),
		nonvoluntaryCtxtSwitches: parseStatusNumber(status, "nonvoluntary_ctxt_switches"),
		vmRssKb: parseStatusNumber(status, "VmRSS"),
		...(openFileDescriptors === undefined ? {} : { openFileDescriptors }),
	};
	return Object.values(facts).some((value) => value !== undefined) ? facts : undefined;
}

function collectThreadFacts(pid: number): WedgedWorkerDiagnosticsRecord["threads"] {
	let tids: string[];
	try {
		tids = readdirSync(`/proc/${pid}/task`);
	} catch {
		return undefined;
	}
	const threads: { tid: number; state?: string; wchan?: string }[] = [];
	for (const tid of tids.slice(0, MAX_THREADS_RECORDED)) {
		const numericTid = Number(tid);
		if (!Number.isFinite(numericTid)) continue;
		const state = parseStatState(readTextOrUndefined(`/proc/${pid}/task/${tid}/stat`));
		const wchan = readTextOrUndefined(`/proc/${pid}/task/${tid}/wchan`)?.trim();
		threads.push({ tid: numericTid, ...(state ? { state } : {}), ...(wchan ? { wchan } : {}) });
	}
	return threads;
}

function trimJournal(path: string): void {
	const contents = readTextOrUndefined(path);
	if (!contents) return;
	const lines = contents.split("\n").filter(Boolean);
	if (lines.length <= MAX_WEDGE_RECORDS) return;
	const kept = `${lines.slice(-MAX_WEDGE_RECORDS).join("\n")}\n`;
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, kept, { mode: 0o600 });
	renameSync(temporary, path);
}

/**
 * Record what the wedged worker process was doing, then let the caller kill it.
 * Best-effort by contract: every failure is swallowed so diagnostics can never
 * break the recovery path they observe.
 */
export function captureWedgedWorkerDiagnostics(path: string, input: WedgedWorkerDiagnosticsInput): void {
	try {
		const record: WedgedWorkerDiagnosticsRecord = {
			version: 1,
			workerId: input.workerId,
			...(input.rootActiveSessionId ? { rootActiveSessionId: input.rootActiveSessionId } : {}),
			pid: input.pid,
			reason: input.reason,
			recordedAt: new Date().toISOString(),
		};
		const processFacts = collectProcessFacts(input.pid);
		if (processFacts) record.process = processFacts;
		const threads = collectThreadFacts(input.pid);
		if (threads) record.threads = threads;
		// The descriptor directory is created by the supervisor that owns it;
		// diagnostics must never create or repair paths. Recursive mkdir on a
		// pseudo-filesystem such as /proc never returns at all, so it is simply
		// out of scope here: a missing directory fails fast and is caught.
		appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		trimJournal(path);
	} catch {
		// Diagnostics are never allowed to disturb worker recovery.
	}
}

/** Read back captured wedge events, skipping malformed lines. */
export function readWedgedWorkerDiagnostics(path: string): WedgedWorkerDiagnosticsRecord[] {
	const contents = readTextOrUndefined(path);
	if (!contents) return [];
	const records: WedgedWorkerDiagnosticsRecord[] = [];
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as WedgedWorkerDiagnosticsRecord;
			if (parsed && parsed.version === 1 && typeof parsed.workerId === "string") {
				records.push(parsed);
			}
		} catch {
			// A torn or hand-edited line must not hide the rest of the journal.
		}
	}
	return records;
}

/** Canonical journal path for a worker, alongside its recovery and orphan journals. */
export function wedgedWorkerDiagnosticsPath(descriptorDir: string, workerId: string): string {
	return join(descriptorDir, `${workerId}.wedge.jsonl`);
}
