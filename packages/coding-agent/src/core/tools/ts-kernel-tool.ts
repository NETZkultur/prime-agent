/**
 * Parallel TS-kernel tool (T112): exposes the worker_threads TypeScript
 * kernel alongside the IPython tool. Both kernels coexist in one session -
 * `ipython` stays Python, `ts` runs JavaScript/TypeScript expressions in
 * its own persistent worker-thread namespace.
 *
 * The kernel instance is session-lifetime lazy: spawned on first use,
 * disposed when the process ends (worker threads die with the process).
 */
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { writeFileSync } from "node:fs";
import { TsKernel } from "../../kernel/ts-kernel.js";

const tsKernelSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript expression or statement sequence to execute in the persistent TS kernel namespace. Variables persist across calls within the session. Use for TS-native logic, JSON shaping, and quick computation alongside the Python ipython tool.",
	}),
});

// Session-lifetime singleton: one shared namespace across all ts() calls.
let sharedKernel: TsKernel | null = null;

function getSharedKernel(): TsKernel {
	if (!sharedKernel) {
		sharedKernel = new TsKernel();
	}
	return sharedKernel;
}

// Operator directive (2026-08-26): the parallel kernel must START WITH the
// session - no CLI parameter, no first-call latency. Tool registration
// happens once per session, so warming here means the worker thread is live
// before the first user turn.
getSharedKernel();

export function createTsKernelToolDefinition(): ToolDefinition<typeof tsKernelSchema> {
	try {
		writeFileSync(
			"/opt/infra-struktur-stack/agent-work/inc0092-wedge-profiles/ts-tool-created.marker",
			new Date().toISOString(),
		);
	} catch {}
	return {
		name: "ts",
		label: "ts",
		description:
			"Execute JavaScript/TypeScript expressions in a persistent TypeScript kernel (own worker thread). Variables persist across calls. Use for TS/JS-native logic - e.g. shaping JSON payloads for APIs, string/regex work, date math - while ipython remains the Python surface.",
		promptSnippet: "ts - persistent TypeScript kernel for JS/TS expressions (parallel to ipython)",
		executionMode: "sequential",
		parameters: tsKernelSchema,
		execute: async (_toolCallId, params) => {
			const t0 = Date.now();
			try {
				const r = await getSharedKernel().evaluate(params.code, 30_000);
				let text = r.ok
					? `${JSON.stringify(r.value)}`
					: `Error: ${r.error}`;
				if (r.output) {
					text = `${r.output}\n=> ${text}`;
				}
				return {
					content: [{ type: "text", text }],
					details: { durationMs: Date.now() - t0, ok: r.ok },
					isError: !r.ok,
				};
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Kernel error: ${message}` }],
					details: { durationMs: Date.now() - t0, ok: false },
					isError: true,
				};
			}
		},
	};
}
