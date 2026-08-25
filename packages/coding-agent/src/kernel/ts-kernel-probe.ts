/**
 * E2E acceptance probe for the parallel TS kernel (T112).
 *
 * Run via: prime-agent --kernel-probe ts
 * Exit 0 only when every step passes: evaluation, namespace persistence,
 * snapshot/restore revival, and hard-deadline enforcement.
 */
import { TsKernel } from "./ts-kernel.js";

export interface ProbeStep {
	step: string;
	ok: boolean;
	detail?: string;
}

export async function runTsKernelProbe(): Promise<{ ok: boolean; steps: ProbeStep[] }> {
	const steps: ProbeStep[] = [];
	let kernel: TsKernel | null = null;
	try {
		// 1. spin up + basic evaluation
		kernel = new TsKernel();
		const r1 = await kernel.evaluate("1 + 1");
		steps.push({ step: "evaluate 1+1 == 2", ok: r1.ok && r1.value === 2,
			detail: `value=${String(r1.value)} err=${r1.error ?? "-"}` });

		// 2. define a variable (namespace write)
		const r2 = await kernel.evaluate("x = 41 + 1");
		steps.push({ step: "define x = 42", ok: r2.ok, detail: `err=${r2.error ?? "-"}` });

		// 3. read it back (persistence within thread)
		const r3 = await kernel.evaluate("x * 2");
		steps.push({ step: "read back x*2 == 84 (persistence)", ok: r3.ok && r3.value === 84,
			detail: `value=${String(r3.value)}` });

		// 4. snapshot + teardown + restore + re-read (revival)
		const snap = await kernel.snapshot();
		await kernel.dispose();
		kernel = new TsKernel();
		await kernel.restore(snap.state);
		const r4 = await kernel.evaluate("x");
		steps.push({ step: "snapshot -> restore -> x == 42 (revival)", ok: r4.ok && r4.value === 42,
			detail: `value=${String(r4.value)}` });

		// 5. functions survive restore? (function definitions in vm context are not JSON-serializable
		//    - document the honest boundary of this pilot slice)
		const r5 = await kernel.evaluate("typeof f");
		const fDefined = await kernel.evaluate("f = function() { return 7 }; typeof f").then((r) => r.value);
		steps.push({ step: "function definition works post-restore (fresh definition)",
			ok: r5.ok && fDefined === "function", detail: `typeof f before=${String(r5.value)} after-def=${String(fDefined)}` });

		// 6. hard deadline: infinite loop must be stopped fast and reported as failure.
		// Measured behavior (better than designed): the worker's vm.runInContext timeout
		// stops the loop INSIDE the thread (~timeoutMs) and returns an error result -
		// the thread survives; the main-side terminate fallback never even fires.
		const t0 = Date.now();
		let deadlineWorked = false;
		let deadlineDetail = "";
		try {
			const r6 = await kernel.evaluate("while (true) {}", 500);
			deadlineWorked = !r6.ok;
			deadlineDetail = r6.error ?? "";
		} catch (e) {
			deadlineWorked = true;
			deadlineDetail = e instanceof Error ? e.message : String(e);
		}
		const elapsed = Date.now() - t0;
		steps.push({ step: "infinite loop stopped by deadline (<3s), reported as failure",
			ok: deadlineWorked && elapsed < 3_000,
			detail: `${elapsed}ms; ${deadlineDetail.slice(0, 60)}` });

		// 7. kernel still usable after deadline termination (fresh thread respawned)
		const r7 = await kernel.evaluate("2 * 21");
		steps.push({ step: "kernel respawns after termination, eval 2*21 == 42",
			ok: r7.ok && r7.value === 42, detail: `value=${String(r7.value)}` });
	} catch (e) {
		steps.push({ step: "unexpected probe failure", ok: false,
			detail: e instanceof Error ? e.message : String(e) });
	} finally {
		if (kernel) await kernel.dispose().catch(() => undefined);
	}
	return { ok: steps.every((s) => s.ok), steps };
}
