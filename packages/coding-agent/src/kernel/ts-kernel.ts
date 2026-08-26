/**
 * Parallel TypeScript kernel (T112 pilot, option C2: worker_threads).
 *
 * A persistent-namespace code-execution kernel running in its own worker
 * thread (own V8 isolate, own event loop) - the PARALLEL alternative to
 * the IPython subprocess kernel. Contract mirrors what the IPython kernel
 * provides today: evaluate code in a persistent namespace, snapshot and
 * restore state across restarts, hard per-request deadline.
 *
 * Purely additive pilot: nothing in the production session path imports
 * this module yet (no caller by design until the E2E probe proves out).
 */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";

/** The worker source runs inside the thread; it owns the persistent namespace. */
const WORKER_SOURCE = `
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { createRequire } = require("node:module");
const nodeRequire = createRequire(process.cwd() + "/");
const { parentPort } = require("node:worker_threads");

// Persistent namespace: survives across evaluate() calls within this thread.
// require shim: user code inside the vm context can load node builtins
// (fs, path, crypto, ...) but NOT arbitrary packages - the pilot keeps a
// builtin allowlist so kernel code cannot silently pull the whole tree.
const ALLOWED_MODULES = new Set(["fs", "path", "crypto", "os", "util", "url", "querystring",
	"events", "stream", "string_decoder", "timers", "zlib", "assert", "readline"]);
function kernelRequire(name) {
	if (!ALLOWED_MODULES.has(name)) {
		throw new Error("kernel require allowlist: '" + name + "' is not in the builtin allowlist");
	}
	return nodeRequire(name);
}

// Console capture: buffered per evaluation, returned with the result.
let captured = [];

function makeCaptureConsole() {
	const fmt = (...a) => a.map((x) => {
		try { return typeof x === "string" ? x : JSON.stringify(x); }
		catch { return String(x); }
	}).join(" ");
	return {
		log: (...a) => { captured.push(fmt(...a)); },
		info: (...a) => { captured.push("info: " + fmt(...a)); },
		warn: (...a) => { captured.push("warn: " + fmt(...a)); },
		error: (...a) => { captured.push("error: " + fmt(...a)); },
	};
}
const kernelConsole = makeCaptureConsole();

let ns = vm.createContext({ __kernel_version: 1, require: kernelRequire, console: kernelConsole });
function serializeNamespace() {
	// Structured values via JSON; functions preserved by SOURCE (closures are
	// lost - an honest boundary documented for the pilot) and re-created on
	// restore via new Function. Marked with a sentinel key.
	const out = {};
	for (const [k, v] of Object.entries(ns)) {
		if (k.startsWith("__kernel") || k === "require") continue;
		if (typeof v === "function") {
			out[k] = { __kernel_fn__: v.toString() };
			continue;
		}
		try {
			out[k] = JSON.parse(JSON.stringify(v ?? null));
		} catch {
			out[k] = "<unserializable>";
		}
	}
	return out;
}

function restoreNamespace(state) {
	ns = vm.createContext({ __kernel_version: 1, require: kernelRequire, console: kernelConsole });
	for (const [k, v] of Object.entries(state)) {
		if (v && typeof v === "object" && typeof v.__kernel_fn__ === "string") {
			try {
				// Re-create from source. Parameters/closure variables are gone;
				// evaluated in the namespace context so globals are reachable.
				const fn = vm.runInContext("(" + v.__kernel_fn__ + ")", ns);
				ns[k] = fn;
			} catch {}
			continue;
		}
		try { ns[k] = JSON.parse(JSON.stringify(v)); } catch { ns[k] = v; }
	}
}

parentPort.on("message", (msg) => {
	try {
		if (msg.type === "eval") {
			let value;
			captured = [];
			try {
				// TypeScript support: Node 24 ships amaro-based type stripping natively.
				// Expressions keep working as before; annotated statements are stripped
				// to plain JS before they hit the vm context.
				const js = stripTypeScriptTypes(msg.code, { mode: "strip" });
				value = vm.runInContext(js, ns, { timeout: msg.timeoutMs || 10_000 });
			} catch (evalError) {
				parentPort.postMessage({ type: "result", id: msg.id, ok: false,
					error: String(evalError && evalError.message || evalError) });
				return;
			}
			let serializedValue = null;
			try {
				const s = JSON.stringify(value);
				// functions/undefined serialize to undefined - report them by source/name
				if (typeof value === "function") {
					serializedValue = "<function " + (value.name || "anonymous") + ">";
				} else if (s !== undefined) {
					serializedValue = JSON.parse(s);
				}
			} catch {
				serializedValue = "<unserializable>";
			}
			parentPort.postMessage({ type: "result", id: msg.id, ok: true,
				value: serializedValue,
				output: captured.join("\\n") });
		} else if (msg.type === "snapshot") {
			parentPort.postMessage({ type: "snapshot", id: msg.id, ok: true,
				state: serializeNamespace() });
		} else if (msg.type === "restore") {
			restoreNamespace(msg.state);
			parentPort.postMessage({ type: "restored", id: msg.id, ok: true });
		}
	} catch (handlerError) {
		parentPort.postMessage({ type: "result", id: msg && msg.id, ok: false,
			error: "kernel handler failure: " + String(handlerError && handlerError.message || handlerError) });
	}
});
`;

export interface EvalResult {
	ok: boolean;
	value?: unknown;
	error?: string;
	/** Captured console.log/info/warn/error lines from this evaluation. */
	output?: string;
}

export interface Snapshot {
	state: Record<string, unknown>;
}

export class TsKernelDeadError extends Error {}

export class TsKernel {
	private worker: Worker | null = null;
	private pending = new Map<string, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		this.worker = new Worker(WORKER_SOURCE, { eval: true });
		this.worker.on("message", (msg) => {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			clearTimeout(entry.timer);
			this.pending.delete(msg.id);
			entry.resolve(msg as Record<string, unknown>);
		});
		this.worker.on("error", (err) => this.failAll(new TsKernelDeadError(`kernel thread died: ${err.message}`)));
		this.worker.on("exit", () => this.failAll(new TsKernelDeadError("kernel thread exited")));
		return this.worker;
	}

	private failAll(err: TsKernelDeadError): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
		this.worker = null;
	}

	/** Evaluate code in the persistent namespace with a hard deadline. */
	async evaluate(code: string, timeoutMs = 10_000): Promise<EvalResult> {
		const id = randomUUID();
		const worker = this.ensureWorker();
		return new Promise<EvalResult>((resolve, reject) => {
			const entry: { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } =
				{ resolve: (m) => resolve(m as unknown as EvalResult), reject };
			this.pending.set(id, entry);
			entry.timer = setTimeout(() => {
				this.pending.delete(id);
				this.worker?.terminate();
				this.worker = null;
				reject(new TsKernelDeadError(`evaluation exceeded ${timeoutMs}ms; kernel thread terminated`));
			}, timeoutMs + 1_000);
			worker.postMessage({ type: "eval", id, code, timeoutMs });
		}).then((m) => m as EvalResult);
	}

	/** Snapshot the persistent namespace (structured-clone-safe values). */
	async snapshot(timeoutMs = 5_000): Promise<Snapshot> {
		const id = randomUUID();
		const worker = this.ensureWorker();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new TsKernelDeadError("snapshot timed out")), timeoutMs + 1_000);
			timer.unref();
			const entry = { resolve: (m: Record<string, unknown>) => resolve({ state: (m as { state: Record<string, unknown> }).state }), reject };
			this.pending.set(id, entry);
			worker.postMessage({ type: "snapshot", id });
		});
	}

	/** Restore a previously snapshotted namespace into a fresh thread. */
	async restore(state: Record<string, unknown>): Promise<void> {
		const id = randomUUID();
		const worker = this.ensureWorker();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new TsKernelDeadError("restore timed out")), 5_000);
			timer.unref();
			this.pending.set(id, { resolve: () => resolve(), reject });
			worker.postMessage({ type: "restore", id, state });
		});
	}

	async dispose(): Promise<void> {
		if (!this.worker) return;
		const w = this.worker;
		this.worker = null;
		this.failAll(new TsKernelDeadError("kernel disposed"));
		await w.terminate();
	}
}
