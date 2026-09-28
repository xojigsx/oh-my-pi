import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { exportSessionToHtml, type SessionData } from "../src/export/html";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { SessionEntry } from "../src/session/session-entries";
import type { SessionManager } from "../src/session/session-manager";

/**
 * Contract: an HTML export built with an obfuscator (the path the custom
 * `/share` handler takes — a blob that leaves the machine) must not contain
 * the designated sensitive field anywhere in its embedded session-data, while
 * the incident row keeps its error category, call identity and timing. If
 * redaction regresses, a share handler uploads HTML whose viewer displays the
 * secret; if the walk erases diagnostics, the incident can no longer be read
 * from the export at all. Without an obfuscator the export stays raw — the
 * local `/export` default must not silently change.
 */

/** Designated sensitive field (WO-4 canary): never a real credential. */
const CANARY = "wo4-canary-XYZZY-9f2a";
const SESSION_TS = "2026-09-27T00:00:00.000Z";
const RESULT_TS = 1_790_000_005_000;
const CALL_ID = "call-abc-123";

function incidentEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: SESSION_TS,
			message: { role: "user", content: [{ type: "text", text: `deploy failed: token ${CANARY} rejected` }] },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: SESSION_TS,
			message: {
				role: "toolResult",
				toolCallId: CALL_ID,
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: `403 with bearer ${CANARY}` }],
				timestamp: RESULT_TS,
			},
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: SESSION_TS,
			message: {
				role: "assistant",
				api: "openai",
				model: "test-model",
				content: [],
				stopReason: "error",
				errorMessage: `request failed after retry: ${CANARY}`,
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
			},
		},
	] as unknown as SessionEntry[];
}

function stubSession(entries: SessionEntry[], sessionFile: string): SessionManager {
	return {
		getHeader: () => ({ type: "session", version: 3, id: "t", timestamp: SESSION_TS, cwd: "/tmp" }),
		getEntries: () => entries,
		getLeafId: () => "e3",
		getSessionFile: () => sessionFile,
	} as unknown as SessionManager;
}

/** Decode the viewer payload the export embeds; a missing tag is a shape regression. */
async function readExportedData(htmlPath: string): Promise<SessionData> {
	const html = await Bun.file(htmlPath).text();
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	if (!encoded) throw new Error("session-data script tag missing from HTML export");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as SessionData;
}

async function exportEntries(
	tempDir: string,
	entries: SessionEntry[],
	obfuscator?: SecretObfuscator,
): Promise<{ outputPath: string; data: SessionData }> {
	// Never on disk: collectSubSessions finds no subagent transcripts next to it.
	const sessionFile = path.join(tempDir, "wo4-session.jsonl");
	const outputPath = path.join(tempDir, "wo4-session.html");
	await exportSessionToHtml(stubSession(entries, sessionFile), undefined, { outputPath, obfuscator });
	return { outputPath, data: await readExportedData(outputPath) };
}

describe("exportSessionToHtml redaction", () => {
	test("scrubs the canary while the incident keeps error category, call identity and timing", async () => {
		using tempDir = TempDir.createSync("@omp-export-redact-");
		const entries = incidentEntries();
		const obfuscator = new SecretObfuscator([{ type: "plain", content: CANARY }]);

		const { data } = await exportEntries(tempDir.path(), entries, obfuscator);
		const flat = JSON.stringify(data);

		// Designated sensitive field absent from the ordinary export…
		expect(flat).not.toContain(CANARY);
		// …but the values around it are not over-redacted.
		expect(flat).toContain("deploy failed: token");
		expect(flat).toContain("403 with bearer");

		const [user, failed, errored] = data.entries.map(entry => (entry as { message?: unknown }).message) as [
			{ content: { text: string }[] },
			{ isError: boolean; toolCallId: string; timestamp: number; content: { text: string }[] },
			{ stopReason: string; errorMessage: string },
		];
		// Incident fact preserved: the failure is still recorded, only the value replaced.
		expect(failed.isError).toBe(true);
		expect(failed.toolCallId).toBe(CALL_ID);
		expect(failed.timestamp).toBe(RESULT_TS);
		expect(failed.content[0].text).not.toContain(CANARY);
		expect(errored.stopReason).toBe("error");
		expect(errored.errorMessage).toContain("request failed after retry:");
		expect(errored.errorMessage).not.toContain(CANARY);
		expect(user.content[0].text).not.toContain(CANARY);

		// Historical raw evidence is never mutated: the session manager's own
		// entries still carry the original value after the export ran.
		expect(JSON.stringify(entries)).toContain(CANARY);
	});

	test("stays raw without an obfuscator — the local /export default is unchanged", async () => {
		using tempDir = TempDir.createSync("@omp-export-raw-");

		const { data } = await exportEntries(tempDir.path(), incidentEntries());

		expect(JSON.stringify(data)).toContain(CANARY);
	});

	test("an obfuscator with no configured secrets exports raw instead of failing", async () => {
		using tempDir = TempDir.createSync("@omp-export-empty-");

		const { data } = await exportEntries(tempDir.path(), incidentEntries(), new SecretObfuscator([]));

		expect(JSON.stringify(data)).toContain(CANARY);
	});
});
