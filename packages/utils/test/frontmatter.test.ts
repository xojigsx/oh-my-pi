import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

describe("parseFrontmatter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts unquoted skill descriptions containing colon-space without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
name: tool-prompt-optimization
description: Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.
enabled: true
---
Skill body`;

		const result = parseFrontmatter(content, { source: "bad-skill/SKILL.md" });

		expect(result.frontmatter).toEqual({
			name: "tool-prompt-optimization",
			description: "Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.",
			enabled: true,
		});
		expect(result.body).toBe("Skill body");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("still warns and falls back for unrecoverable malformed frontmatter", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parseFrontmatter(content, { source: "broken.md" });

		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		expect(result.body).toBe("Body content");
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("broken.md") }),
		);
	});

	it("reparses each fallback value so one malformed line can't corrupt its siblings", () => {
		// `scope: "text","thinking"` is not valid YAML, forcing the line-by-line
		// fallback. The sibling `condition` value must not inherit literal quotes,
		// and `enabled` must reparse to a boolean (issue #4796).
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
condition: "(?i)pre.existing"
scope: "text","thinking"
enabled: true
---
Body`;

		const result = parseFrontmatter(content, { source: "rule.md" });

		expect(result.frontmatter.condition).toBe("(?i)pre.existing");
		expect(result.frontmatter.enabled).toBe(true);
		// The unrecoverable line survives as its raw trimmed string.
		expect(result.frontmatter.scope).toBe('"text","thinking"');
		expect(result.body).toBe("Body");
		expect(warnSpy).toHaveBeenCalled();
	});

	// Modeled on anthropics/claude-code pr-review-toolkit
	// `agents/code-simplifier.md`: a description plain scalar carrying literal
	// `\n` escapes plus raw continuation lines — a `key: value` lookalike and a
	// bare prose line — that make the strict record fail (F4).
	const PLUGIN_AGENT_MD = [
		"---",
		"name: code-simplifier",
		"description: Use this agent when code has been written or modified.\\n\\nExamples:\\n\\n<example>",
		'user: "Please add authentication to the /api/users endpoint"',
		"<function call omitted for brevity>",
		"model: opus",
		"---",
		"You are an expert code simplification specialist.",
	].join("\n");
	const REPAIRED_DESCRIPTION =
		"Use this agent when code has been written or modified.\n\nExamples:\n\n<example>\n" +
		'user: "Please add authentication to the /api/users endpoint"\n' +
		"<function call omitted for brevity>";

	it("rewrites a failing multi-line plain scalar as a block scalar without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = parseFrontmatter(PLUGIN_AGENT_MD, { source: "code-simplifier.md" });

		// Text is preserved modulo newline representation: literal `\n` becomes a
		// real newline, raw line breaks stay line breaks, nothing else moves.
		expect(result.frontmatter).toEqual({
			name: "code-simplifier",
			description: REPAIRED_DESCRIPTION,
			model: "opus",
		});
		expect(result.body).toBe("You are an expert code simplification specialist.");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("keeps the first parse strict: repair only runs on failure", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = ["---", "name: x", "description: line one\\nline two", "---", "Body"].join("\n");

		const result = parseFrontmatter(content, { source: "parseable.md" });

		// The record parses on the first attempt, so the literal two-character
		// `\n` sequences stay untouched.
		expect(result.frontmatter.description).toBe("line one\\nline two");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("does not repair without repair: true", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = parseFrontmatter(PLUGIN_AGENT_MD, { source: "code-simplifier.md", repair: false });

		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("code-simplifier.md") }),
		);
		// Strict parse failed, so the plain line-by-line fallback runs instead of
		// the block-scalar rewrite: only the first physical line survives.
		expect(result.frontmatter.description).toBe(
			"Use this agent when code has been written or modified.\\n\\nExamples:\\n\\n<example>",
		);
	});

	it("does not mask malformed YAML that cannot round-trip", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// The failure sits on `invalid: [unclosed array`: every repair candidate
		// either has no preceding plain scalar or would only swallow well-formed
		// key lines, so the record must still warn and fall back.
		const content = ["---", "name: broken-agent", "invalid: [unclosed array", "---", "Body content"].join("\n");

		const result = parseFrontmatter(content, { source: "broken-agent.md" });

		expect(result.frontmatter).toEqual({ name: "broken-agent", invalid: "[unclosed array" });
		expect(result.body).toBe("Body content");
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("broken-agent.md") }),
		);
	});
});
