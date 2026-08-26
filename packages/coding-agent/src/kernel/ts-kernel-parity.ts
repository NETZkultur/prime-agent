/**
 * Cross-kernel parity suite (T112 pass 2): run the SAME task in Python and
 * in the TS kernel, then compare both results against a language-neutral
 * expected value. A task passes only when BOTH kernels produce the same
 * answer - this pins the two kernels together so a drift in either one
 * surfaces immediately.
 */
import { spawnSync } from "node:child_process";
import { TsKernel } from "./ts-kernel.js";

export interface ParityTask {
	name: string;
	python: string;
	ts: string;
	expected: unknown;
}

export const PARITY_TASKS: ParityTask[] = [
	{
		name: "arithmetic",
		python: "print(2 + 3 * 4)",
		ts: "2 + 3 * 4",
		expected: 14,
	},
	{
		name: "string-reverse",
		python: 'print("kernel"[::-1])',
		ts: '"kernel".split("").reverse().join("")',
		expected: "lenrek",
	},
	{
		name: "json-shaping",
		python: "import json; print(json.dumps({'a': [1, 2], 'b': 'x'}, sort_keys=True))",
		ts: 'JSON.stringify({a: [1, 2], b: "x"})',
		expected: '{"a": [1, 2], "b": "x"}',
	},
	{
		name: "list-filter-sum",
		python: "print(sum(n for n in range(1, 11) if n % 2 == 0))",
		ts: "[1,2,3,4,5,6,7,8,9,10].filter(n => n % 2 === 0).reduce((s, n) => s + n, 0)",
		expected: 30,
	},
	{
		name: "regex-extract",
		python: "import re; print(re.findall(r'\\d+', 'a1b22c333')[1])",
		ts: "'a1b22c333'.match(/\\d+/g)[1]",
		expected: "22",
	},
	{
		name: "sort-by-key",
		python: "import json; xs = sorted([{'k': 3}, {'k': 1}, {'k': 2}], key=lambda e: e['k']); print(json.dumps([e['k'] for e in xs]))",
		ts: "JSON.stringify([{k:3},{k:1},{k:2}].sort((a,b) => a.k-b.k).map(e => e.k))",
		expected: "[1, 2, 3]",
	},
];

function runPython(code: string): { ok: boolean; out: string } {
	const r = spawnSync("python3", ["-c", code], { encoding: "utf-8", timeout: 10_000 });
	return { ok: r.status === 0, out: (r.stdout || "").trim() };
}

function normalize(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "string") {
		const s = v.trim();
		// Semantic normalization: a string that IS json compares by structure,
		// so python's spaced dumps and js's compact stringify cannot drift.
		try {
			const parsed = JSON.parse(s);
			return JSON.stringify(parsed);
		} catch {
			return s;
		}
	}
	if (typeof v === "number") return String(v);
	return JSON.stringify(v);
}

export interface ParityResult {
	name: string;
	pythonOk: boolean;
	tsOk: boolean;
	match: boolean;
	detail?: string;
}

export async function runParitySuite(): Promise<{ ok: boolean; results: ParityResult[] }> {
	const results: ParityResult[] = [];
	const kernel = new TsKernel();
	try {
		for (const task of PARITY_TASKS) {
			const py = runPython(task.python);
			let tsRes;
			try {
				tsRes = await kernel.evaluate(task.ts, 5_000);
			} catch (e) {
				tsRes = { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
			const expectedStr = normalize(task.expected);
			const pyOk = py.ok && normalize(py.out) === expectedStr;
			const tsOk = tsRes.ok && normalize(tsRes.value) === expectedStr;
			results.push({
				name: task.name,
				pythonOk: pyOk,
				tsOk,
				match: pyOk && tsOk,
				detail: pyOk && tsOk ? undefined
					: `python=${JSON.stringify(py.out)} ts=${JSON.stringify(tsRes.value ?? tsRes.error)} expected=${expectedStr}`,
			});
		}
	} finally {
		await kernel.dispose().catch(() => undefined);
	}
	return { ok: results.every((r) => r.match), results };
}
