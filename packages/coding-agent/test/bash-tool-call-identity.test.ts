/**
 * OMP_TOOL_CALL_ID / OMP_SESSION_ID export contract: wrappers that record
 * process lifetimes join an OS process row back to the tool call that spawned
 * it, so a real child of the bash tool must observe the executing call's id —
 * and never a previous call's stale value.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

// The suite asserts exact absence/presence of the identity vars in spawned
// children; an outer omp session exporting them (nested invocations) would
// leak into the inherited environment and defeat the assertions.
const AMBIENT_IDENTITY_VARS = ["OMP_TOOL_CALL_ID", "OMP_SESSION_ID"] as const;
const savedAmbientIdentity = AMBIENT_IDENTITY_VARS.map(name => [name, process.env[name]] as const);
beforeAll(() => {
	for (const name of AMBIENT_IDENTITY_VARS) delete process.env[name];
});
afterAll(() => {
	for (const [name, value] of savedAmbientIdentity) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function makeSession(sessionId?: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		...(sessionId === undefined ? {} : { getSessionId: () => sessionId }),
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

async function run(tool: BashTool, toolCallId: string, command: string): Promise<string> {
	const result = await tool.execute(toolCallId, { command });
	expect(result.isError).toBeUndefined();
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("BashTool call-identity child environment", () => {
	it("exports the executing call id and session id to a real child process", async () => {
		// `sh` is a real OS child (not an in-process builtin): the vars must be
		// in the exported process environment, not merely shell variables.
		const tool = new BashTool(makeSession("session-42"));
		const text = await run(
			tool,
			"call-identity-1",
			`sh -c 'echo id=$OMP_TOOL_CALL_ID sid=$OMP_SESSION_ID'`,
		);

		expect(text).toContain("id=call-identity-1");
		expect(text).toContain("sid=session-42");
	});

	it("does not export OMP_SESSION_ID when the session exposes no session id", async () => {
		// A bogus empty/stale session id would let a wrapper join process rows
		// to the wrong session, so the variable stays absent instead.
		const tool = new BashTool(makeSession());
		const text = await run(
			tool,
			"call-identity-2",
			`sh -c 'if [ -z "\${OMP_SESSION_ID+x}" ]; then echo sid-unset; else echo sid-set; fi'`,
		);

		expect(text).toContain("sid-unset");
		expect(text).not.toContain("sid-set");
	});

	it("does not leak the previous call's identity into the next call's child", async () => {
		// Both calls share one persistent shell session (same session key), so a
		// per-session leak would surface here as the first call's id.
		const tool = new BashTool(makeSession("session-42"));
		const first = await run(tool, "call-identity-a", `sh -c 'echo $OMP_TOOL_CALL_ID'`);
		const second = await run(tool, "call-identity-b", `sh -c 'echo $OMP_TOOL_CALL_ID'`);

		expect(first).toContain("call-identity-a");
		expect(second).toContain("call-identity-b");
		expect(second).not.toContain("call-identity-a");
	});
});
