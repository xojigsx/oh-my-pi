import { YAML } from "bun";
import { truncate } from "./format";
import * as logger from "./logger";

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Convert kebab-case to camelCase (e.g. "thinking-level" -> "thinkingLevel") */
function kebabToCamel(key: string): string {
	if (!key.includes("-")) return key;
	return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively normalize object keys from kebab-case to camelCase — the
 * representation convention for frontmatter consumed inside this codebase.
 * Exported for loaders that parse with `rawKeys: true` to validate exact
 * spec-defined keys, then normalize for storage.
 */
export function normalizeFrontmatterKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) {
		let changed = false;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const out: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const v = obj[i];
			const nv = normalizeFrontmatterKeys(v);
			out[i] = nv;
			if (nv !== v) changed = true;
		}
		return (changed ? (out as unknown) : obj) as T;
	}
	let changed = false;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const nk = key.includes("-") ? kebabToCamel(key) : key;
		const nv = normalizeFrontmatterKeys(value);
		result[nk] = nv;
		if (nk !== key || nv !== value) changed = true;
	}
	return (changed ? result : obj) as T;
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
	let changed = false;
	const lines = metadata.split("\n").map(line => {
		const match = line.match(PLAIN_SCALAR_KEY_VALUE);
		if (!match) return line;
		const [, prefix, rawValue, suffix] = match;
		const value = rawValue.trimEnd();
		if (!value.includes(": ")) return line;
		if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0])) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : undefined;
}

function parseYamlRecord(metadata: string, repairTabs: boolean): Record<string, unknown> | null {
	const loaded = YAML.parse(repairTabs ? metadata.replaceAll("\t", "  ") : metadata);
	if (loaded === null || loaded === undefined) return null;
	if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
	return loaded as Record<string, unknown>;
}

const TOP_LEVEL_PLAIN_KEY = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/;

/**
 * Targeted repair for a failing record whose offending plain scalar spans
 * multiple raw lines (F4: anthropics/claude-code pr-review-toolkit ships
 * `agents/code-simplifier.md` whose `description` carries literal `\n`
 * escapes plus raw continuation lines — `key: value` lookalikes such as
 * `user: "..."` and bare prose lines — that no strict YAML parser accepts;
 * Claude Code tolerates the shape).
 *
 * Detection: find the first line where the record stops parsing, then take the
 * nearest preceding plain-scalar key carrying a literal `\n` (the tell of an
 * authored multi-line scalar; the nearest preceding plain scalar otherwise) as
 * the offending scalar. Rewrite it as a `|2-` literal block scalar absorbing
 * the lines up to the next top-level key (or the end of the record),
 * unescaping `\n` to real newlines. `|-` (literal, strip) is chosen so the
 * text survives: line breaks stay line breaks and no other byte moves — the
 * parsed value differs from the source scalar only in newline representation
 * (literal `\\n` vs real newlines, real line breaks kept rather than folded).
 *
 * A rewrite is accepted only when the re-parse round-trips: the repaired
 * value equals its source text modulo newline representation and every
 * top-level key outside the absorbed region still resolves. Anything else
 * returns `undefined` and the caller keeps the strict warn/throw fallback, so
 * malformed YAML that cannot round-trip is never masked.
 */
function repairMultiLinePlainScalar(metadata: string): string | undefined {
	// The strict attempt already widened tabs; keep the rewrite aligned with
	// what the re-parse will see.
	const lines = metadata.replaceAll("\t", "  ").split("\n");

	// First line at which the record stops parsing as a mapping. A failure on
	// (or before) the first line leaves no preceding scalar to repair.
	let failAt = -1;
	for (let i = 0; i < lines.length; i++) {
		try {
			if (parseYamlRecord(lines.slice(0, i + 1).join("\n"), true) !== null) continue;
		} catch {
			// The prefix failed to parse; record it below.
		}
		failAt = i;
		break;
	}
	if (failAt <= 0) return undefined;

	// Candidate owners: plain-scalar keys before the failure. Flow/quoted/
	// explicit values are self-terminating and never the offending scalar.
	const candidates: { index: number; key: string; value: string }[] = [];
	for (let i = 0; i < failAt; i++) {
		const entry = TOP_LEVEL_PLAIN_KEY.exec(lines[i]);
		if (!entry) continue;
		const value = entry[2];
		if (value.length > 0 && FLOW_OR_EXPLICIT_VALUE_START.has(value[0])) continue;
		candidates.push({ index: i, key: entry[1], value });
	}
	// An authored multi-line scalar carries literal `\n` escapes — prefer those
	// (closest to the failure first), then the plain scalars closest to it.
	candidates.sort((a, b) => {
		const aEscaped = lines[a.index].includes("\\n");
		const bEscaped = lines[b.index].includes("\\n");
		if (aEscaped !== bEscaped) return aEscaped ? -1 : 1;
		return b.index - a.index;
	});

	for (const { index: start, key, value } of candidates) {
		// Only a top-level key line (or the end of the record) can terminate the
		// block: any other remainder starts on a non-key line, which never
		// parses as a mapping.
		const splits: number[] = [];
		for (let j = start + 1; j < lines.length; j++) {
			if (TOP_LEVEL_PLAIN_KEY.test(lines[j])) splits.push(j);
		}
		splits.push(lines.length);

		for (const split of splits) {
			const region = lines.slice(start + 1, split);
			// Only absorb a region holding actual non-key content — a block that
			// merely swallows well-formed `key: value` lines is not the failing
			// multi-line-scalar shape and would silently delete sibling keys.
			if (!region.some(line => line.trim() !== "" && !TOP_LEVEL_PLAIN_KEY.test(line))) continue;

			// Literal `\n` sequences become real newlines; every other byte of the
			// source scalar survives verbatim.
			const unescaped = [value, ...region].join("\n").replaceAll("\\n", "\n");
			// `|-` chomps trailing line breaks; mirror that for the round-trip check.
			const expected = unescaped.replace(/\n+$/u, "");
			const block = [`${key}: |2-`, ...unescaped.split("\n").map(line => (line === "" ? "" : `  ${line}`))];
			const rebuilt = [...lines.slice(0, start), ...block, ...lines.slice(split)].join("\n");

			let repaired: Record<string, unknown> | null;
			try {
				repaired = parseYamlRecord(rebuilt, true);
			} catch {
				continue;
			}
			if (repaired === null || repaired[key] !== expected) continue;

			// Round-trip: every top-level key outside the absorbed region resolves.
			let intact = true;
			for (let j = 0; j < lines.length; j++) {
				if (j > start && j < split) continue;
				const other = TOP_LEVEL_PLAIN_KEY.exec(lines[j]);
				if (other && !(other[1] in repaired)) {
					intact = false;
					break;
				}
			}
			if (intact) return rebuilt;
		}
	}
	return undefined;
}

export class FrontmatterError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse YAML frontmatter (${source}): ${error.message}`, { cause: error });
		this.name = "FrontmatterError";
	}

	override toString(): string {
		// Format the error with stack and detail, including the error message, stack, and source if present
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

export interface FrontmatterOptions {
	/** Source of the content (alias: source) */
	location?: unknown;
	/** Source of the content (alias for location) */
	source?: unknown;
	/** Fallback frontmatter values */
	fallback?: Record<string, unknown>;
	/** Normalize the content */
	normalize?: boolean;
	/** Level of error handling */
	level?: "off" | "warn" | "fatal";
	/**
	 * Attempt lenient recovery of near-miss input before failing: quote
	 * ambiguous plain scalars, replace tabs with spaces, strip leading HTML
	 * comments ahead of the opening delimiter, and — when the record still
	 * fails — rewrite the offending multi-line plain scalar as a block scalar
	 * that round-trips its text (modulo newline representation). Default
	 * `true`. Spec-conformant loaders set `false` so malformed input is
	 * rejected instead of silently repaired (CRLF newline normalization still
	 * applies).
	 */
	repair?: boolean;
	/**
	 * Preserve frontmatter keys verbatim instead of normalizing kebab-case to
	 * camelCase. Default `false`. Strict spec loaders use this so a standard
	 * key (e.g. `allowed-tools`) is never aliased with its camelCase form.
	 */
	rawKeys?: boolean;
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, body } where body has frontmatter stripped
 */
export function parseFrontmatter(
	content: string,
	options?: FrontmatterOptions,
): { frontmatter: Record<string, unknown>; body: string } {
	const {
		location,
		source,
		fallback,
		normalize = true,
		level = "warn",
		repair = true,
		rawKeys = false,
	} = options ?? {};
	const finalizeKeys = (fm: Record<string, unknown>): Record<string, unknown> =>
		rawKeys ? fm : normalizeFrontmatterKeys(fm);
	const loc = location ?? source;
	const frontmatter: Record<string, unknown> = { ...fallback };

	const newlineNormalized = normalize ? content.replace(/\r\n?/g, "\n") : content;
	const normalized = normalize && repair ? stripHtmlComments(newlineNormalized) : newlineNormalized;
	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const loaded = parseYamlRecord(metadata, repair);
		return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
	} catch (error) {
		if (repair) {
			const quotedMetadata = quoteAmbiguousPlainScalars(metadata);
			if (quotedMetadata) {
				try {
					const loaded = parseYamlRecord(quotedMetadata, true);
					return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
				} catch {
					// Fall through to the block-scalar repair below.
				}
			}

			const blockMetadata = repairMultiLinePlainScalar(metadata);
			if (blockMetadata !== undefined) {
				try {
					const loaded = parseYamlRecord(blockMetadata, true);
					if (loaded !== null) {
						return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
					}
				} catch {
					// Fall through to the existing warning + simple key/value fallback.
				}
			}
		}

		const err = new FrontmatterError(
			error instanceof Error ? error : new Error(`YAML: ${error}`),
			loc ?? `Inline '${truncate(content, 64)}'`,
		);
		if (level === "warn" || level === "fatal") {
			logger.warn("Failed to parse YAML frontmatter", { err: err.toString() });
		}
		if (level === "fatal") {
			throw err;
		}

		// Simple key: value fallback. Reparse each value on its own so one
		// malformed line (e.g. `scope: "text","thinking"`) can't leave sibling
		// values wrapped in literal quotes; values that don't parse as YAML fall
		// back to the raw trimmed string (issue #4796).
		for (const line of metadata.split("\n")) {
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			if (!match) continue;
			const raw = match[2].trim();
			let value: unknown = raw;
			if (raw.length > 0) {
				try {
					const parsed = YAML.parse(raw);
					if (parsed !== null && typeof parsed !== "object") value = parsed;
					else if (Array.isArray(parsed)) value = parsed;
				} catch {
					// keep the raw string
				}
			}
			frontmatter[match[1]] = value;
		}

		return { frontmatter: finalizeKeys(frontmatter), body };
	}
}
