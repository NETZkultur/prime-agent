import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorInternals {
	handleConnection(socket: Socket): void;
	log: ReturnType<typeof vi.fn>;
}

const tempDirs: string[] = [];
const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
	for (const socket of openSockets.splice(0)) socket.destroy();
	for (const server of openServers.splice(0)) {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-drop-logging-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes: 90 }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.log = vi.fn();
	return supervisor;
}

async function acceptConnection(supervisor: SupervisorInternals): Promise<{ accepted: Socket; client: Socket }> {
	const directory = tempDirs[tempDirs.length - 1];
	const socketPath = join(directory, "accept.sock");
	const acceptedPromise = new Promise<Socket>((resolveAccept) => {
		const server = createServer((socket) => resolveAccept(socket));
		openServers.push(server);
		server.listen(socketPath, () => undefined);
	});
	await new Promise<void>((resolveListen) => {
		const server = openServers[openServers.length - 1];
		if (server.listening) {
			resolveListen();
			return;
		}
		server.once("listening", () => resolveListen());
	});
	const client = await new Promise<Socket>((resolveConnect, rejectConnect) => {
		const socket = new Socket();
		openSockets.push(socket);
		socket.once("error", rejectConnect);
		socket.connect(socketPath, () => {
			socket.off("error", rejectConnect);
			resolveConnect(socket);
		});
	});
	const accepted = await acceptedPromise;
	openSockets.push(accepted);
	supervisor.handleConnection(accepted);
	return { accepted, client };
}

describe("daemon supervisor accepted-connection drop logging", () => {
	it("logs the cause when an accepted client connection errors", async () => {
		const supervisor = makeSupervisor();
		const { accepted } = await acceptConnection(supervisor);

		accepted.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

		await vi.waitFor(() =>
			expect(supervisor.log).toHaveBeenCalledWith(
				expect.stringMatching(/Daemon client connection .+ error: read ECONNRESET/),
			),
		);
		accepted.destroy();
	});

	it("logs when an accepted client connection closes normally", async () => {
		const supervisor = makeSupervisor();
		const { accepted, client } = await acceptConnection(supervisor);

		client.end();
		await new Promise<void>((resolveClose) => accepted.once("close", () => resolveClose()));

		expect(supervisor.log).toHaveBeenCalledWith(expect.stringMatching(/Daemon client connection .+ closed/));
	});
});
