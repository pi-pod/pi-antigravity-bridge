import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AcpConnection } from "./acp/connection.js";
import { redactText } from "./redact.js";

const run = promisify(execFile);

/** Only a connection marker goes into Pi. Google credentials stay with the official agy client. */
export function clientLoginMarker(): OAuthCredentials {
	return { access: "agy-client-managed", refresh: "agy-client-managed", expires: Number.MAX_SAFE_INTEGER };
}

/** Native ACP refuses browserless authenticate calls. Its official terminal login supports
 * pasted codes/URLs instead, so give that client a PTY and carry its interaction through Pi. */
async function terminalLogin(binary: string, callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<void> {
	if (process.platform === "win32") throw new Error("Sign in with agy interactively on this Windows host");
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	// script's PTY command has a separate session/process group. Record that
	// command's PID before exec, not just the outer script wrapper's PID.
	const directory = mkdtempSync(join(tmpdir(), "pipod-agy-login-"));
	const groupFile = join(directory, "command-group");
	const command = join(directory, "login-command");
	writeFileSync(command, `#!/bin/sh\numask 077\nprintf '%s\\n' "$$" > ${quote(groupFile)}\nexec ${quote(binary)} acp --login\n`, { mode: 0o700 });
	const args = process.platform === "darwin"
		? ["-q", "/dev/null", command]
		: ["-qefc", `exec ${quote(command)}`, "/dev/null"];
	const child = spawn("script", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
	let exited = false;
	let output = "";
	let foundUrl!: (url: string) => void;
	const url = new Promise<string>((resolve) => { foundUrl = resolve; });
	const consume = (chunk: Buffer) => {
		output = (output + chunk.toString("utf8")).slice(-64 * 1024);
		const match = /https:\/\/accounts\.google\.com\/[^\s\x1b]+(?=[\r\n\t ])/.exec(output);
		if (!match) return;
		try {
			const candidate = new URL(match[0]);
			if (["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(candidate.pathname)) foundUrl(candidate.href);
		} catch { /* wait for a complete URL */ }
	};
	child.stdout.on("data", consume);
	child.stderr.on("data", consume);
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", () => reject(new Error("Could not start the official agy terminal login; install the script utility (util-linux on Linux)")));
		child.once("close", (code) => {
			exited = true;
			if (code === 0) resolve();
			else reject(new Error(`Antigravity terminal sign-in failed (${code ?? "signal"})`));
		});
	});
	let commandGroup: number | undefined;
	const readGroup = () => {
		try {
			const value = readFileSync(groupFile, "utf8").trim();
			const pid = Number(value);
			if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid) commandGroup = pid;
		} catch { /* the command may not have started yet */ }
		return commandGroup;
	};
	const groupAlive = (pid: number) => {
		try { process.kill(-pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
	};
	const kill = (force = false) => {
		const groups = new Set([readGroup(), child.pid]);
		for (const pid of groups) if (pid) try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone; checked after escalation */ }
	};
	let rejectAbort!: (reason: unknown) => void;
	const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
	const abort = () => { kill(); rejectAbort(signal.reason ?? new Error("Antigravity sign-in cancelled")); };
	signal.addEventListener("abort", abort, { once: true });
	const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
	try {
		signal.throwIfAborted();
		const authorization = await wait(Promise.race([url, done.then(() => undefined)]));
		if (authorization) {
			callbacks.onAuth({ url: authorization, instructions: "Complete Google's sign-in, then paste the authorization code or the complete final page URL below. The official agy client validates it." });
			signal.throwIfAborted();
			const answer = await wait(callbacks.onPrompt({ message: "Paste the Antigravity authorization code or complete final URL" }));
			signal.throwIfAborted();
			if (!answer.trim() || answer.length > 64 * 1024 || /[\x00-\x1f\x7f]/.test(answer)) throw new Error("Enter a single authorization code or URL without terminal control characters");
			if (exited || !child.stdin.writable) throw new Error("Antigravity sign-in ended before the code was entered");
			child.stdin.write(`${answer.trim()}\n`);
		}
		await wait(done);
	} finally {
		signal.removeEventListener("abort", abort);
		kill();
		await Promise.race([done.catch(() => undefined), delay(1500)]);
		kill(true);
		await Promise.race([done.catch(() => undefined), delay(1500)]);
		try {
			const group = readGroup();
			for (let i = 0; group && groupAlive(group) && i < 30; i++) await delay(50);
			if (group && groupAlive(group)) throw new Error(`Could not terminate the owned Antigravity login process group (${group})`);
		} finally {
			// Only executable/PID metadata was written, never URLs or pasted codes.
			output = "";
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

export async function loginAntigravity(binary: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000);
	signal.throwIfAborted();
	callbacks.onProgress?.("Signing in through the official Antigravity CLI. Google credentials stay on the machine running inference.");
	const headless = !!(process.env.PI_POD_ID || process.env.PI_POD_SERVER_POD_ID || process.env.SSH_CONNECTION || process.env.SSH_CLIENT || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY));
	if (headless) await terminalLogin(binary, callbacks, signal);
	else {
		const connection = new AcpConnection({ cwd: process.cwd(), bin: binary, binArgs: ["acp"], log: () => {}, onUpdate: () => {}, onExit: () => {} });
		const abort = () => connection.kill();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await connection.start();
			await connection.request("authenticate", { methodId: "oauth-personal" }, 10 * 60_000);
		} finally {
			signal.removeEventListener("abort", abort);
			connection.kill();
		}
	}
	signal.throwIfAborted();
	// A terminal wrapper's zero status alone is not evidence that the official client
	// saved a usable login. Verify the account-backed catalog without an inference turn.
	try { await run(binary, ["models"], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 }); }
	catch (error) { throw new Error(`Antigravity did not confirm a usable login: ${redactText(error instanceof Error ? error.message : String(error))}`); }
	return clientLoginMarker();
}
