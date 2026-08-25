/** Identity of a mutating command tracked by {@link MutationDrainLatch}. */
export interface MutationDrainLabel {
	/** Daemon command type, e.g. "prompt_and_wait" or "worker_passivate_idle_children". */
	readonly type?: string;
	/** Daemon command id, when the mutating command carries one. */
	readonly id?: string;
	/** Protocol client id that issued the command, when known. */
	readonly clientId?: string;
	/** Active session id the mutation targets, when known. */
	readonly sessionId?: string;
}

/** A tracked in-flight mutation with its start time; the token returned by begin(). */
export interface MutationDrainEntry extends MutationDrainLabel {
	readonly startedAt: number;
}

/** Read-only snapshot of an active mutation with its current age. */
export interface MutationDrainSnapshot extends MutationDrainLabel {
	readonly startedAt: number;
	readonly ageMs: number;
}

export interface MutationDrainWaitOptions {
	/**
	 * Per-mutation drain budget in milliseconds. A mutation older than this is
	 * treated as stale: it no longer blocks the drain. This bounds drain latency
	 * per mutation instead of one global window, so a single hung or long-running
	 * mutation cannot stall a drain forever (idle eviction, #1616).
	 */
	readonly staleAfterMs?: number;
}

/** Renders active mutations for diagnostics: `[type=x id=y clientId=z ageMs=123]`. */
export function describeActiveMutations(mutations: readonly MutationDrainSnapshot[]): string {
	if (mutations.length === 0) return "none";
	return mutations
		.map((mutation) => {
			const fields = [
				mutation.type === undefined ? undefined : `type=${mutation.type}`,
				mutation.id === undefined ? undefined : `id=${mutation.id}`,
				mutation.clientId === undefined ? undefined : `clientId=${mutation.clientId}`,
				mutation.sessionId === undefined ? undefined : `sessionId=${mutation.sessionId}`,
				`ageMs=${mutation.ageMs}`,
			].filter((field): field is string => field !== undefined);
			return `[${fields.join(" ")}]`;
		})
		.join(" ");
}

/**
 * Tracks in-flight mutating commands so idle eviction and update-restart
 * preparation can wait for them to drain. Each mutation carries an identity
 * (command type/id/client) and a start time, so a drain that cannot complete can
 * name exactly which mutations are still active.
 */
export class MutationDrainLatch {
	private readonly activeEntries: MutationDrainEntry[] = [];
	private readonly waiters = new Set<() => void>();

	/**
	 * Registers a mutating command. Returns the token that {@link end} removes.
	 * `startedAt` is injectable for tests that need to backdate a mutation.
	 */
	begin(label: MutationDrainLabel = {}, startedAt: number = Date.now()): MutationDrainEntry {
		const entry: MutationDrainEntry = { ...label, startedAt };
		this.activeEntries.push(entry);
		return entry;
	}

	/** Removes a mutation. Without a token, removes the oldest (legacy counter semantics). */
	end(token?: MutationDrainEntry): void {
		if (token) {
			const index = this.activeEntries.indexOf(token);
			if (index >= 0) this.activeEntries.splice(index, 1);
		} else {
			this.activeEntries.shift();
		}
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	/** Snapshot of currently active mutations with ages, for diagnostics. */
	activeMutations(now: number = Date.now()): MutationDrainSnapshot[] {
		return this.activeEntries.map((entry) => ({
			...entry,
			ageMs: Math.max(0, now - entry.startedAt),
		}));
	}

	private drainAbortedError(abortMessage: string): Error {
		const snapshot = this.activeMutations();
		const error = new Error(`${abortMessage}; active mutations: ${describeActiveMutations(snapshot)}`);
		Object.assign(error, { activeMutations: snapshot });
		return error;
	}

	async waitForDrain(
		remaining: number,
		signal: AbortSignal,
		abortMessage: string,
		options: MutationDrainWaitOptions = {},
	): Promise<void> {
		const staleAfterMs = options.staleAfterMs ?? Number.POSITIVE_INFINITY;
		if (signal.aborted) throw this.drainAbortedError(abortMessage);
		const freshEntries = (now: number) => this.activeEntries.filter((entry) => now - entry.startedAt < staleAfterMs);
		while (freshEntries(Date.now()).length > remaining) {
			const now = Date.now();
			// Next moment a fresh entry crosses the stale threshold, so the wait
			// wakes up even if nothing calls end() (per-mutation timeout).
			const nextStaleAt = Math.min(...freshEntries(now).map((entry) => entry.startedAt + staleAfterMs));
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const settle = (error?: Error) => {
					if (settled) return;
					settled = true;
					this.waiters.delete(onDrained);
					if (staleTimer !== undefined) clearTimeout(staleTimer);
					signal.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				};
				const onDrained = () => settle();
				const onAbort = () => settle(this.drainAbortedError(abortMessage));
				this.waiters.add(onDrained);
				signal.addEventListener("abort", onAbort, { once: true });
				const staleTimer =
					Number.isFinite(nextStaleAt) && staleAfterMs < Number.POSITIVE_INFINITY
						? setTimeout(() => settle(), Math.max(0, nextStaleAt - Date.now()))
						: undefined;
				staleTimer?.unref?.();
			});
			if (signal.aborted) throw this.drainAbortedError(abortMessage);
		}
	}
}
