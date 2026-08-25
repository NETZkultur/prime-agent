import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	// T112 pilot: parallel TS kernel E2E probe (--kernel-probe ts). Purely
	// additive - handled before any heavy imports so the probe never touches
	// the production session path.
	if (args[0] === "--kernel-probe" && args[1] === "ts") {
		try {
			const { runTsKernelProbe } = await import("./kernel/ts-kernel-probe.js");
			const result = await runTsKernelProbe();
			for (const s of result.steps) {
				process.stdout.write(`${s.ok ? "PASS" : "FAIL"}  ${s.step}${s.detail ? " | " + s.detail : ""}\n`);
			}
			process.stdout.write(`\nkernel probe: ${result.ok ? "ALL GREEN" : "FAILED"}\n`);
			process.exit(result.ok ? 0 : 1);
		} catch (probeError) {
			process.stdout.write(`kernel probe crashed: ${String(probeError)}\n`);
			process.exit(1);
		}
	}
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await main(process.argv.slice(2));
		} finally {
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}
