import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { isRecord } from "@oh-my-pi/pi-utils";
import { obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { type SessionEntry, type SessionHeader, TITLE_CHANGE_ENTRY_TYPE } from "../session/session-entries";
import type { SessionData, SubSession } from "./html";

/**
 * Collect every regex-matched secret value across the WHOLE snapshot before
 * redacting any single field: an earlier field's friendly-name placeholder
 * must not leak a later field's secret through the collision pre-scan.
 */
function collectExportRegexSecretValues(o: SecretObfuscator, data: SessionData): Set<string> {
	const values = new Set<string>();
	const add = (value: string | undefined): void => {
		if (value === undefined) return;
		for (const secretValue of o.collectRegexSecretValuesForObfuscation(value)) {
			values.add(secretValue);
		}
	};
	const addJsonStrings = (value: unknown): void => {
		if (typeof value === "string") {
			add(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) addJsonStrings(item);
			return;
		}
		if (!isRecord(value)) return;
		for (const item of Object.values(value)) addJsonStrings(item);
	};
	const addContent = (content: string | (TextContent | ImageContent)[]): void => {
		if (typeof content === "string") {
			add(content);
			return;
		}
		for (const block of content) {
			if (block.type === "text") add(block.text);
		}
	};
	const addOutputMeta = (meta: OutputMeta | undefined): void => {
		if (!meta) return;
		add(meta.source?.value);
		if (!meta.diagnostics) return;
		add(meta.diagnostics.summary);
		for (const message of meta.diagnostics.messages) add(message);
	};
	const addMessage = (message: AgentMessage): void => {
		switch (message.role) {
			case "user":
			case "developer":
			case "custom":
			case "hookMessage":
			case "toolResult":
				addContent(message.content as string | (TextContent | ImageContent)[]);
				return;
			case "assistant":
				add(message.errorMessage);
				for (const block of message.content) {
					if (block.type === "text") add(block.text);
					else if (block.type === "thinking") add(block.thinking);
					else if (block.type === "toolCall") {
						addJsonStrings(block.arguments);
						add(block.intent);
						add(block.rawBlock);
					}
				}
				return;
			case "bashExecution":
				add(message.command);
				add(message.output);
				addOutputMeta(message.meta);
				return;
			case "pythonExecution":
				add(message.code);
				add(message.output);
				addOutputMeta(message.meta);
				return;
			case "branchSummary":
				add(message.summary);
				return;
			case "compactionSummary":
				add(message.summary);
				add(message.shortSummary);
				if (message.blocks) addContent(message.blocks);
				return;
			case "fileMention":
				for (const file of message.files) {
					add(file.path);
					add(file.content);
				}
				return;
			default:
				return;
		}
	};
	const addEntry = (entry: SessionEntry): void => {
		switch (entry.type) {
			case "message":
				addMessage(entry.message);
				return;
			case "compaction":
				add(entry.summary);
				add(entry.shortSummary);
				return;
			case "branch_summary":
				add(entry.summary);
				return;
			case "custom_message":
				addContent(entry.content);
				return;
			case "session_init":
				add(entry.systemPrompt);
				add(entry.task);
				return;
			case "label":
				add(entry.label);
				return;
			case TITLE_CHANGE_ENTRY_TYPE:
				add(entry.title);
				add(entry.previousTitle);
				add(entry.trigger);
				return;
			default:
				return;
		}
	};
	const addHeader = (header: SessionHeader | null): void => {
		if (!header) return;
		add(header.title);
		add(header.cwd);
		for (const previousSessionFile of header.previousSessionFiles ?? []) add(previousSessionFile);
	};

	addHeader(data.header);
	add(data.systemPrompt);
	for (const tool of data.tools ?? []) add(tool.description);
	for (const entry of data.entries) addEntry(entry);
	for (const sub of Object.values(data.subSessions ?? {})) {
		addHeader(sub.header);
		for (const entry of sub.entries) addEntry(entry);
	}
	return values;
}

function redactExportHeader(
	o: SecretObfuscator,
	header: SessionHeader | null,
	sharedRegexSecretValues: ReadonlySet<string>,
): SessionHeader | null {
	if (!header) return header;
	return {
		...header,
		title: header.title === undefined ? undefined : o.obfuscate(header.title, sharedRegexSecretValues),
		cwd: o.obfuscate(header.cwd, sharedRegexSecretValues),
		previousSessionFiles: header.previousSessionFiles?.map(previousSessionFile =>
			o.obfuscate(previousSessionFile, sharedRegexSecretValues),
		),
	};
}

/**
 * Redact secrets from an export snapshot. Exports that leave the machine
 * (`/share` snapshots, the HTML session export handed to a custom share
 * handler) rewrite every text-bearing field through the obfuscator. The walk
 * is typed end-to-end (no generic object traversal): inline image bytes are
 * left intact (size-trimmed later by the share sealing path) and opaque,
 * untyped payloads we cannot redact field-by-field (`compaction.preserveData`,
 * extension `details`/`data`, `mode_change.data`, structured output schemas)
 * are dropped so they cannot leak. Returns a fresh snapshot; `data` (the
 * session manager's own entries) is never mutated.
 */
export function redactSessionDataForExport(o: SecretObfuscator, data: SessionData): SessionData {
	const sharedRegexSecretValues = collectExportRegexSecretValues(o, data);
	return {
		...data,
		header: redactExportHeader(o, data.header, sharedRegexSecretValues),
		systemPrompt:
			data.systemPrompt === undefined ? undefined : o.obfuscate(data.systemPrompt, sharedRegexSecretValues),
		tools: data.tools?.map(tool => ({
			...tool,
			description: o.obfuscate(tool.description, sharedRegexSecretValues),
		})),
		entries: data.entries.map(entry => redactExportEntry(o, entry, sharedRegexSecretValues)),
		subSessions: data.subSessions
			? Object.fromEntries(
					Object.entries(data.subSessions).map(([key, sub]) => [
						key,
						redactExportSubSession(o, sub, sharedRegexSecretValues),
					]),
				)
			: data.subSessions,
	};
}

function redactExportSubSession(
	o: SecretObfuscator,
	sub: SubSession,
	sharedRegexSecretValues: ReadonlySet<string>,
): SubSession {
	return {
		...sub,
		header: redactExportHeader(o, sub.header, sharedRegexSecretValues),
		entries: sub.entries.map(entry => redactExportEntry(o, entry, sharedRegexSecretValues)),
	};
}

function redactExportEntry(
	o: SecretObfuscator,
	entry: SessionEntry,
	sharedRegexSecretValues: ReadonlySet<string>,
): SessionEntry {
	switch (entry.type) {
		case "message":
			return { ...entry, message: redactExportMessage(o, entry.message, sharedRegexSecretValues) };
		case "compaction":
			return {
				...entry,
				summary: o.obfuscate(entry.summary, sharedRegexSecretValues),
				shortSummary:
					entry.shortSummary === undefined ? undefined : o.obfuscate(entry.shortSummary, sharedRegexSecretValues),
				details: undefined,
				preserveData: undefined,
			};
		case "branch_summary":
			return { ...entry, summary: o.obfuscate(entry.summary, sharedRegexSecretValues), details: undefined };
		case "custom_message":
			return {
				...entry,
				content: redactExportContent(o, entry.content, sharedRegexSecretValues),
				details: undefined,
			};
		case "custom":
			return { ...entry, data: undefined };
		case "mode_change":
			return { ...entry, data: undefined };
		case "session_init":
			return {
				...entry,
				systemPrompt: o.obfuscate(entry.systemPrompt, sharedRegexSecretValues),
				task: o.obfuscate(entry.task, sharedRegexSecretValues),
				outputSchema: undefined,
			};
		case "label":
			return {
				...entry,
				label: entry.label === undefined ? undefined : o.obfuscate(entry.label, sharedRegexSecretValues),
			};
		case TITLE_CHANGE_ENTRY_TYPE:
			return {
				...entry,
				title: o.obfuscate(entry.title, sharedRegexSecretValues),
				previousTitle:
					entry.previousTitle === undefined
						? undefined
						: o.obfuscate(entry.previousTitle, sharedRegexSecretValues),
				trigger: entry.trigger === undefined ? undefined : o.obfuscate(entry.trigger, sharedRegexSecretValues),
			};
		default:
			return entry;
	}
}

function redactExportContent(
	o: SecretObfuscator,
	content: string | (TextContent | ImageContent)[],
	sharedRegexSecretValues: ReadonlySet<string>,
): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return o.obfuscate(content, sharedRegexSecretValues);
	return content.map(block =>
		block.type === "text" ? { ...block, text: o.obfuscate(block.text, sharedRegexSecretValues) } : block,
	);
}

/** Redact freeform strings in tool output metadata (source path/URL, diagnostics); numeric truncation info is preserved. */
function redactExportOutputMeta(
	o: SecretObfuscator,
	meta: OutputMeta | undefined,
	sharedRegexSecretValues: ReadonlySet<string>,
): OutputMeta | undefined {
	if (!meta) return meta;
	return {
		...meta,
		source: meta.source
			? { ...meta.source, value: o.obfuscate(meta.source.value, sharedRegexSecretValues) }
			: meta.source,
		diagnostics: meta.diagnostics
			? {
					summary: o.obfuscate(meta.diagnostics.summary, sharedRegexSecretValues),
					messages: meta.diagnostics.messages.map(message => o.obfuscate(message, sharedRegexSecretValues)),
				}
			: meta.diagnostics,
	};
}

function redactExportMessage(
	o: SecretObfuscator,
	message: AgentMessage,
	sharedRegexSecretValues: ReadonlySet<string>,
): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				...message,
				providerPayload: undefined,
				content: redactExportContent(o, message.content, sharedRegexSecretValues),
			} as AgentMessage;
		case "custom":
		case "hookMessage":
			return {
				...message,
				details: undefined,
				content: redactExportContent(o, message.content, sharedRegexSecretValues),
			} as AgentMessage;
		case "toolResult":
			return {
				...message,
				details: undefined,
				content: redactExportContent(o, message.content, sharedRegexSecretValues) as (TextContent | ImageContent)[],
			};
		case "assistant":
			// Drop opaque provider-replay state (encrypted reasoning / native history) the viewer
			// never reads and we cannot redact field-by-field: `providerPayload`, any
			// `redactedThinking` blocks, and native Anthropic server-tool blocks
			// (`server_tool_use` input / `web_search_tool_result` encrypted_content).
			return {
				...message,
				providerPayload: undefined,
				errorMessage:
					message.errorMessage === undefined
						? undefined
						: o.obfuscate(message.errorMessage, sharedRegexSecretValues),
				content: message.content.flatMap((block): AssistantMessage["content"] => {
					if (block.type === "redactedThinking" || block.type === "anthropicServerTool") return [];
					if (block.type === "text") return [{ ...block, text: o.obfuscate(block.text, sharedRegexSecretValues) }];
					if (block.type === "thinking") {
						return [{ ...block, thinking: o.obfuscate(block.thinking, sharedRegexSecretValues) }];
					}
					if (block.type === "toolCall") {
						return [
							{
								...block,
								arguments: obfuscateToolArguments(o, block.arguments, sharedRegexSecretValues),
								intent:
									block.intent === undefined ? undefined : o.obfuscate(block.intent, sharedRegexSecretValues),
								rawBlock:
									block.rawBlock === undefined
										? undefined
										: o.obfuscate(block.rawBlock, sharedRegexSecretValues),
							},
						];
					}
					return [block];
				}),
			};
		case "bashExecution":
			return {
				...message,
				command: o.obfuscate(message.command, sharedRegexSecretValues),
				output: o.obfuscate(message.output, sharedRegexSecretValues),
				meta: redactExportOutputMeta(o, message.meta, sharedRegexSecretValues),
			};
		case "pythonExecution":
			return {
				...message,
				code: o.obfuscate(message.code, sharedRegexSecretValues),
				output: o.obfuscate(message.output, sharedRegexSecretValues),
				meta: redactExportOutputMeta(o, message.meta, sharedRegexSecretValues),
			};
		case "branchSummary":
			return { ...message, summary: o.obfuscate(message.summary, sharedRegexSecretValues) };
		case "compactionSummary":
			return {
				...message,
				providerPayload: undefined,
				summary: o.obfuscate(message.summary, sharedRegexSecretValues),
				shortSummary:
					message.shortSummary === undefined
						? undefined
						: o.obfuscate(message.shortSummary, sharedRegexSecretValues),
				blocks:
					message.blocks === undefined
						? undefined
						: (redactExportContent(o, message.blocks, sharedRegexSecretValues) as (TextContent | ImageContent)[]),
			};
		case "fileMention":
			return {
				...message,
				files: message.files.map(file => ({
					...file,
					path: o.obfuscate(file.path, sharedRegexSecretValues),
					content: o.obfuscate(file.content, sharedRegexSecretValues),
				})),
			};
		default:
			return message;
	}
}
