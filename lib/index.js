import { createRequire } from "node:module";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { escapeText, isModelInvocable, isSkillName, isUserInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { Buffer as Buffer$1 } from "node:buffer";
//#region src/skill-file.ts
function parseBoolean(data, key) {
	if (!Object.hasOwn(data, key)) return void 0;
	const value = data[key];
	if (value === true || value === 1 || value === "1" || value === "true") return true;
	if (value === false || value === 0 || value === "0" || value === "false") return false;
	throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}
function frontmatter(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	if (match === null) throw new Error("SKILL.md is missing YAML frontmatter");
	const parsed = parse(match[1] ?? "");
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("SKILL.md frontmatter must be an object");
	return {
		data: parsed,
		body: raw.slice(match[0].length).trim()
	};
}
function parseSkillMarkdown(raw, directory) {
	const parsed = frontmatter(raw);
	const name = parsed.data.name;
	const description = parsed.data.description;
	if (typeof name !== "string" || !isSkillName(name)) throw new Error(`invalid skill name "${String(name)}"`);
	if (typeof description !== "string" || description.trim().length === 0) throw new Error("frontmatter requires a non-empty description");
	for (const legacy of [
		"disableModelInvocation",
		"modelInvocable",
		"userInvocable"
	]) if (Object.hasOwn(parsed.data, legacy)) throw new Error(`unsupported legacy frontmatter field "${legacy}"`);
	const invocation = {
		modelInvocable: parseBoolean(parsed.data, "disable-model-invocation") !== true,
		userInvocable: parseBoolean(parsed.data, "user-invocable") !== false
	};
	const whenToUse = parsed.data.whenToUse;
	if (whenToUse !== void 0 && (typeof whenToUse !== "string" || whenToUse.trim().length === 0)) throw new Error("frontmatter field \"whenToUse\" must be a non-empty string");
	const metadata = parsed.data.metadata;
	if (metadata !== void 0 && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) throw new Error("frontmatter field \"metadata\" must be an object");
	return {
		name,
		description: description.trim(),
		...typeof whenToUse === "string" ? { whenToUse: whenToUse.trim() } : {},
		invocation,
		source: "runtime",
		provider: "skillflux-cache",
		resourceBase: {
			kind: "directory",
			path: directory
		},
		path: join(directory, "SKILL.md"),
		...metadata === void 0 ? {} : { metadata },
		content: parsed.body
	};
}
async function inspectSkillDirectory(directory, limits, signal) {
	let fileCount = 0;
	let totalBytes = 0;
	const hash = createHash("sha256");
	async function visit(current) {
		signal?.throwIfAborted();
		const entries = await readdir(current, { withFileTypes: true });
		signal?.throwIfAborted();
		entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
		for (const entry of entries) {
			const path = join(current, entry.name);
			const relativePath = relative(directory, path).replaceAll("\\", "/");
			if (relativePath === ".skillflux.json") continue;
			const stats = await lstat(path);
			signal?.throwIfAborted();
			if (stats.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relativePath}`);
			if (stats.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!stats.isFile()) throw new Error(`unsupported filesystem entry: ${relativePath}`);
			fileCount += 1;
			totalBytes += stats.size;
			if (fileCount > limits.maxFiles) throw new Error(`skill exceeds ${limits.maxFiles} files`);
			if (totalBytes > limits.maxBytes) throw new Error(`skill exceeds ${limits.maxBytes} bytes`);
			const content = await readFile(path);
			signal?.throwIfAborted();
			hash.update(relativePath).update("\0").update(content).update("\0");
		}
	}
	await visit(directory);
	signal?.throwIfAborted();
	const skillPath = join(directory, "SKILL.md");
	const raw = await readFile(skillPath, "utf8");
	signal?.throwIfAborted();
	return {
		definition: parseSkillMarkdown(raw, directory),
		fileCount,
		totalBytes,
		contentHash: hash.digest("hex")
	};
}
//#endregion
//#region src/cache.ts
const execFileAsync = promisify(execFile);
const MANIFEST_NAME = ".skillflux.json";
const CACHE_ID = /^[0-9a-f]{24}$/u;
function assertWithin(root, target) {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	const pathFromRoot = relative(normalizedRoot, normalizedTarget);
	if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new Error(`refusing filesystem operation outside the SkillFlux cache: ${normalizedTarget}`);
}
function cacheId(source, ref, skillId) {
	return createHash("sha256").update(JSON.stringify([
		source,
		ref,
		skillId
	])).digest("hex").slice(0, 24);
}
function immutableArchiveUrl(source, ref) {
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(source);
	if (match === null || !/^[0-9a-f]{40}$/u.test(ref)) throw new Error("remote cache source is not a pinned public GitHub repository");
	const owner = match[1];
	const repository = match[2];
	if (owner === void 0 || repository === void 0) throw new Error("invalid GitHub repository source");
	return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tar.gz/${ref}`;
}
function validManifest(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return item.version === 1 && typeof item.cacheId === "string" && CACHE_ID.test(item.cacheId) && typeof item.source === "string" && typeof item.ref === "string" && /^[0-9a-f]{40}$/u.test(item.ref) && typeof item.skillId === "string" && typeof item.name === "string" && typeof item.description === "string" && (item.installs === void 0 || typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0) && (item.qualityScore === void 0 || typeof item.qualityScore === "number" && Number.isSafeInteger(item.qualityScore) && item.qualityScore >= 0 && item.qualityScore <= 100) && (item.stars === void 0 || typeof item.stars === "number" && Number.isSafeInteger(item.stars) && item.stars >= 0) && (item.pushedAt === void 0 || typeof item.pushedAt === "string") && (item.discoverySources === void 0 || Array.isArray(item.discoverySources) && item.discoverySources.every((source) => source === "skills.sh" || source === "github")) && typeof item.installedAt === "string" && typeof item.fileCount === "number" && Number.isSafeInteger(item.fileCount) && item.fileCount >= 1 && typeof item.totalBytes === "number" && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0 && typeof item.contentHash === "string" && /^[0-9a-f]{64}$/u.test(item.contentHash) && (item.whenToUse === void 0 || typeof item.whenToUse === "string");
}
function skillsCliPath() {
	const packagePath = createRequire(import.meta.url).resolve("skills/package.json");
	return join(dirname(packagePath), "bin", "cli.mjs");
}
function commandOutput(error) {
	if (typeof error !== "object" || error === null) return String(error);
	const record = error;
	return [
		record.message,
		record.stdout,
		record.stderr
	].filter((value) => typeof value === "string").join("\n");
}
function isLoopbackProxyFailure(error) {
	return /Failed to connect to (?:127\.0\.0\.1|localhost) port \d+/iu.test(commandOutput(error));
}
function withoutLoopbackProxy(environment) {
	const result = { ...environment };
	for (const key of [
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy"
	]) delete result[key];
	const inheritedCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
	const offset = Number.isSafeInteger(inheritedCount) && inheritedCount >= 0 && inheritedCount < 100 ? inheritedCount : 0;
	result.GIT_CONFIG_COUNT = String(offset + 2);
	result[`GIT_CONFIG_KEY_${offset}`] = "http.proxy";
	result[`GIT_CONFIG_VALUE_${offset}`] = "";
	result[`GIT_CONFIG_KEY_${offset + 1}`] = "https.proxy";
	result[`GIT_CONFIG_VALUE_${offset + 1}`] = "";
	return result;
}
var SkillCache = class {
	options;
	root;
	entriesRoot;
	stagingRoot;
	constructor(options) {
		this.options = options;
		this.root = resolve(options.root);
		this.entriesRoot = join(this.root, "entries");
		this.stagingRoot = join(this.root, ".staging");
	}
	async list() {
		await mkdir(this.entriesRoot, { recursive: true });
		const names = await readdir(this.entriesRoot);
		return (await Promise.all(names.filter((name) => CACHE_ID.test(name)).map((name) => this.read(name)))).filter((entry) => entry !== void 0).sort((left, right) => right.manifest.installedAt.localeCompare(left.manifest.installedAt, "en"));
	}
	async get(id) {
		if (!CACHE_ID.test(id)) return void 0;
		return await this.read(id);
	}
	async find(source, ref, skillId) {
		return await this.get(cacheId(source, ref, skillId));
	}
	async load(entry, signal) {
		const inspected = await inspectSkillDirectory(entry.directory, {
			maxFiles: this.options.maxFiles,
			maxBytes: this.options.maxBytes
		}, signal);
		if (inspected.definition.name !== entry.manifest.name) throw new Error("cached skill name no longer matches its manifest");
		if (inspected.fileCount !== entry.manifest.fileCount || inspected.totalBytes !== entry.manifest.totalBytes || inspected.contentHash !== entry.manifest.contentHash) throw new Error("cached skill contents no longer match their manifest");
		return inspected.definition;
	}
	async install(candidate, signal) {
		signal?.throwIfAborted();
		const id = cacheId(candidate.source, candidate.ref, candidate.skillId);
		const existing = await this.get(id);
		signal?.throwIfAborted();
		if (existing !== void 0) return existing;
		const staging = join(this.stagingRoot, randomUUID());
		const workspace = join(staging, "workspace");
		const downloaded = join(workspace, ".agents", "skills", candidate.skillId);
		const destination = join(this.entriesRoot, id);
		assertWithin(this.root, staging);
		assertWithin(this.root, destination);
		await mkdir(workspace, { recursive: true });
		try {
			const source = immutableArchiveUrl(candidate.source, candidate.ref);
			const args = [
				skillsCliPath(),
				"add",
				source,
				"--skill",
				candidate.skillId,
				"--agent",
				"codex",
				"--yes",
				"--copy"
			];
			const baseEnvironment = {
				...process.env,
				CI: "1",
				NO_COLOR: "1",
				SKILLS_NO_TELEMETRY: "1",
				SKILLS_EXTRACT_MAX_FILES: "5000"
			};
			const execute = async (env) => {
				if (this.options.runInstaller !== void 0) await this.options.runInstaller({
					executable: process.execPath,
					args,
					cwd: workspace,
					timeoutMs: this.options.installTimeoutMs,
					...signal === void 0 ? {} : { signal },
					env
				});
				else await execFileAsync(process.execPath, args, {
					cwd: workspace,
					timeout: this.options.installTimeoutMs,
					maxBuffer: 2097152,
					signal,
					env
				});
			};
			try {
				await execute(baseEnvironment);
			} catch (error) {
				if (!isLoopbackProxyFailure(error)) throw error;
				await rm(workspace, {
					recursive: true,
					force: true
				});
				await mkdir(workspace, { recursive: true });
				await execute(withoutLoopbackProxy(baseEnvironment));
			}
			await access(downloaded);
			if (candidate.skillFileHash !== void 0) {
				const downloadedSkill = await readFile(join(downloaded, "SKILL.md"));
				if (createHash("sha256").update(downloadedSkill).digest("hex") !== candidate.skillFileHash) throw new Error("downloaded SKILL.md does not match the GitHub search preview");
			}
			const inspected = await inspectSkillDirectory(downloaded, {
				maxFiles: this.options.maxFiles,
				maxBytes: this.options.maxBytes
			}, signal);
			if (inspected.definition.name !== candidate.skillId) throw new Error(`downloaded skill name "${inspected.definition.name}" does not match "${candidate.skillId}"`);
			const manifest = {
				version: 1,
				cacheId: id,
				source: candidate.source,
				ref: candidate.ref,
				skillId: candidate.skillId,
				name: inspected.definition.name,
				description: inspected.definition.description,
				...inspected.definition.whenToUse === void 0 ? {} : { whenToUse: inspected.definition.whenToUse },
				installs: candidate.installs,
				qualityScore: candidate.qualityScore,
				stars: candidate.stars,
				...candidate.pushedAt === void 0 ? {} : { pushedAt: candidate.pushedAt },
				discoverySources: candidate.discoverySources,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				fileCount: inspected.fileCount,
				totalBytes: inspected.totalBytes,
				contentHash: inspected.contentHash
			};
			await writeFile(join(downloaded, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
			await mkdir(this.entriesRoot, { recursive: true });
			try {
				await rename(downloaded, destination);
			} catch (error) {
				const raced = await this.get(id);
				signal?.throwIfAborted();
				if (raced !== void 0) return raced;
				throw error;
			}
			return {
				manifest,
				directory: destination
			};
		} finally {
			await rm(staging, {
				recursive: true,
				force: true
			}).catch(() => void 0);
		}
	}
	async clean(selector, active = /* @__PURE__ */ new Set()) {
		if (selector === "all") {
			await mkdir(this.entriesRoot, { recursive: true });
			const directories = (await readdir(this.entriesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && CACHE_ID.test(entry.name)).map((entry) => ({
				id: entry.name,
				directory: join(this.entriesRoot, entry.name)
			}));
			const removed = [];
			const skipped = [];
			for (const entry of directories) {
				if (active.has(entry.id)) {
					skipped.push(entry.id);
					continue;
				}
				assertWithin(this.entriesRoot, entry.directory);
				await rm(entry.directory, {
					recursive: true,
					force: true
				});
				removed.push(entry.id);
			}
			return {
				removed,
				skipped
			};
		}
		const entries = [await this.get(selector)].filter((entry) => entry !== void 0);
		if (entries.length === 0) throw new Error(`unknown cache id "${selector}"`);
		const removed = [];
		const skipped = [];
		for (const entry of entries) {
			if (active.has(entry.manifest.cacheId)) {
				skipped.push(entry.manifest.cacheId);
				continue;
			}
			assertWithin(this.entriesRoot, entry.directory);
			await rm(entry.directory, {
				recursive: true,
				force: true
			});
			removed.push(entry.manifest.cacheId);
		}
		return {
			removed,
			skipped
		};
	}
	async read(id) {
		if (!CACHE_ID.test(id)) return void 0;
		const directory = join(this.entriesRoot, id);
		assertWithin(this.entriesRoot, directory);
		try {
			const raw = await readFile(join(directory, MANIFEST_NAME), "utf8");
			const manifest = JSON.parse(raw);
			if (!validManifest(manifest) || manifest.cacheId !== id) return void 0;
			return {
				manifest,
				directory
			};
		} catch {
			return;
		}
	}
};
//#endregion
//#region src/catalog.ts
function description(value, maxLength) {
	const normalized = value.replaceAll(/\s+/gu, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
function sourceEntries(skills, maxLength) {
	return skills.map((skill) => ({
		name: skill.name,
		description: description(skill.description, maxLength)
	}));
}
function catalogText(entries, update) {
	const lines = entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`);
	return update ? [
		"<system-reminder>",
		"The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:",
		"",
		"<available_skills>",
		...lines,
		"</available_skills>",
		"",
		...entries.length === 0 ? ["No skills are currently mounted through the `skill` tool. Do not use names from earlier catalogs."] : ["Use only names in this replacement catalog. Call `skill` with the exact name before acting."],
		"A user may still invoke a user-invocable skill directly with `/skill-name`.",
		"</system-reminder>"
	].join("\n") : [
		"<system-reminder>",
		"SkillFlux mounted the following skills for this turn:",
		"",
		"<available_skills>",
		...lines,
		"</available_skills>",
		"",
		"Call `skill` with an exact listed name before acting. The list contains summaries only.",
		"A user may also invoke a user-invocable skill directly with `/skill-name`.",
		"</system-reminder>"
	].join("\n");
}
/**
* Estimate prompt tokens conservatively without depending on a model-specific
* tokenizer. Three UTF-8 bytes per token slightly overestimates typical
* English text while staying close to one token per CJK code point.
*/
function estimateTextTokens(value) {
	return value.length === 0 ? 0 : Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}
/** Estimate the largest catalog prompt form (the replacement/update form). */
function estimateCatalogTokens(skills, maxLength) {
	if (!Number.isSafeInteger(maxLength) || maxLength < 3) throw new RangeError("catalog description max length must be an integer greater than or equal to 3");
	if (skills.length === 0) return 0;
	return estimateTextTokens(catalogText(sourceEntries(skills, maxLength), true));
}
function digest(entries) {
	return createHash("sha256").update(entries.map((entry) => JSON.stringify([entry.name, entry.description])).join("\n")).digest("hex");
}
function readEntries(source) {
	const entries = source.entries;
	if (!Array.isArray(entries)) return void 0;
	const result = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) return void 0;
		const item = entry;
		if (typeof item.name !== "string" || item.name.length === 0 || typeof item.description !== "string") return void 0;
		result.push({
			name: item.name,
			description: item.description
		});
	}
	return result;
}
function readRemoteEntries(source) {
	const entries = source.entries;
	if (!Array.isArray(entries)) return void 0;
	const result = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) return void 0;
		const item = entry;
		if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.source !== "string" || typeof item.ref !== "string" || typeof item.installs !== "number" || !Array.isArray(item.discoverySources) || !item.discoverySources.every((value) => typeof value === "string") || typeof item.qualityScore !== "number" || typeof item.relevanceScore !== "number" || typeof item.stars !== "number" || typeof item.recentlyActive !== "boolean" || typeof item.trustedSource !== "boolean") return void 0;
		result.push({
			id: item.id,
			name: item.name,
			source: item.source,
			ref: item.ref,
			installs: item.installs,
			discoverySources: item.discoverySources,
			qualityScore: item.qualityScore,
			relevanceScore: item.relevanceScore,
			stars: item.stars,
			recentlyActive: item.recentlyActive,
			trustedSource: item.trustedSource
		});
	}
	return result;
}
function remoteDigest(entries) {
	return createHash("sha256").update(entries.map((entry) => JSON.stringify([
		entry.id,
		entry.name,
		entry.source,
		entry.ref,
		entry.installs,
		entry.discoverySources,
		entry.qualityScore,
		entry.relevanceScore,
		entry.stars,
		entry.recentlyActive,
		entry.trustedSource
	])).join("\n")).digest("hex");
}
function history(agent) {
	const visible = new Set(agent.session.surface.nodes);
	let published = false;
	for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
		const event = agent.session.events[index];
		if (event === void 0 || event.type !== "user/message" || event.data.source.kind !== "skill-catalog") continue;
		const entries = readEntries(event.data.source);
		if (entries === void 0) continue;
		published = true;
		if (visible.has(event.seq)) return {
			published,
			visibleDigest: digest(entries)
		};
	}
	return { published };
}
function remoteHistory(agent) {
	const visible = new Set(agent.session.surface.nodes);
	let published = false;
	for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
		const event = agent.session.events[index];
		if (event === void 0 || event.type !== "user/message" || event.data.source.kind !== "skillflux-candidates") continue;
		const entries = readRemoteEntries(event.data.source);
		if (entries === void 0) continue;
		published = true;
		if (visible.has(event.seq)) return {
			published,
			visibleDigest: remoteDigest(entries)
		};
	}
	return { published };
}
function currentCatalog(messages) {
	for (const message of messages) {
		if (message.source.kind !== "skill-catalog") continue;
		const entries = readEntries(message.source);
		if (entries !== void 0) return {
			message,
			entries
		};
	}
}
function catalogMessage(entries, update) {
	return createUserMessage({
		content: [{
			type: "text",
			text: catalogText(entries, update)
		}],
		source: {
			kind: "skill-catalog",
			form: "catalog",
			...update ? { update: true } : {},
			entries
		}
	});
}
function updateCatalog(agent, messages, skills, maxDescriptionLength) {
	const entries = sourceEntries(skills, maxDescriptionLength);
	const nextDigest = digest(entries);
	const prior = history(agent);
	const existing = currentCatalog(messages);
	if (prior.visibleDigest === nextDigest) return existing === void 0 ? [...messages] : messages.filter((message) => message.id !== existing.message.id);
	if (existing !== void 0 && digest(existing.entries) === nextDigest) return [...messages];
	if (!prior.published && entries.length === 0) return existing === void 0 ? [...messages] : messages.filter((message) => message.id !== existing.message.id);
	const catalog = catalogMessage(entries, prior.published);
	return existing === void 0 ? [...messages, catalog] : messages.map((message) => message.id === existing.message.id ? catalog : message);
}
function candidateEntries(candidates) {
	return candidates.map((candidate) => ({
		id: candidate.id,
		name: candidate.name,
		source: candidate.source,
		ref: candidate.ref,
		installs: candidate.installs,
		discoverySources: candidate.discoverySources,
		qualityScore: candidate.qualityScore,
		relevanceScore: candidate.relevanceScore,
		stars: candidate.stars,
		recentlyActive: candidate.recentlyActive,
		trustedSource: candidate.trustedSource
	}));
}
function buildRemoteCandidateMessage(candidates, update) {
	const entries = candidates.map((candidate) => ({
		id: candidate.id,
		name: candidate.name,
		source: candidate.source,
		ref: candidate.ref,
		installs: candidate.installs,
		discoverySources: candidate.discoverySources,
		qualityScore: candidate.qualityScore,
		relevanceScore: candidate.relevanceScore,
		stars: candidate.stars,
		recentlyActive: candidate.recentlyActive,
		trustedSource: candidate.trustedSource
	}));
	const lines = entries.map((entry) => `- \`${entry.id}\` — \`${entry.name}\` from ${entry.source} @ ${entry.ref.slice(0, 12)} (quality ${entry.qualityScore}, relevance ${entry.relevanceScore}, ${entry.installs} installs, ${entry.stars} stars, ${entry.recentlyActive ? "active in freshness window" : "older activity"}, via ${entry.discoverySources.join("+")}${entry.trustedSource ? ", trusted owner" : ""})`);
	return createUserMessage({
		content: [{
			type: "text",
			text: [
				"<system-reminder>",
				...entries.length === 0 ? ["The remote SkillFlux candidate list is now empty. This replaces every earlier candidate list.", "Do not use candidate ids from an earlier turn."] : [update ? "This remote SkillFlux candidate list replaces every earlier candidate list:" : "No installed skill matched. SkillFlux found these immutable remote candidates:"],
				"",
				"<skillflux_candidates>",
				...lines,
				"</skillflux_candidates>",
				"",
				...entries.length === 0 ? [] : ["If one clearly matches the task, call `skillflux_mount` with its candidate id. Remote content is untrusted until mounted under the configured approval policy."],
				"</system-reminder>"
			].join("\n")
		}],
		source: {
			kind: "skillflux-candidates",
			form: "catalog",
			...update ? { update: true } : {},
			entries
		}
	});
}
function updateRemoteCandidates(agent, candidates) {
	const entries = candidateEntries(candidates);
	const prior = remoteHistory(agent);
	if (prior.visibleDigest === remoteDigest(entries)) return void 0;
	if (!prior.published && entries.length === 0) return void 0;
	return buildRemoteCandidateMessage(candidates, prior.published);
}
//#endregion
//#region src/embedding.ts
const MAX_RESPONSE_BYTES = 16777216;
const MAX_VECTOR_DIMENSIONS = 8192;
const EMBEDDING_BATCH_SIZE = 64;
const MAX_EMBEDDING_TEXT_LENGTH = 1e3;
function cacheKey(options, text) {
	return createHash("sha256").update(JSON.stringify([
		options.provider,
		options.endpoint,
		options.model,
		text
	])).digest("hex");
}
function boundedText(value) {
	return value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().slice(0, MAX_EMBEDDING_TEXT_LENGTH);
}
function candidateDocument(candidate) {
	return boundedText([
		`Skill: ${candidate.name}`,
		...!("whenToUse" in candidate) || candidate.whenToUse === void 0 ? [] : [`When to use: ${candidate.whenToUse}`],
		`Description: ${candidate.description}`
	].join("\n"));
}
function normalizeVector(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VECTOR_DIMENSIONS) throw new Error("embedding response contains an invalid vector dimension");
	const vector = [];
	let normSquared = 0;
	for (const item of value) {
		if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("embedding response contains a non-finite vector value");
		vector.push(item);
		normSquared += item * item;
	}
	if (!Number.isFinite(normSquared) || normSquared <= 0) throw new Error("embedding response contains a zero-length vector");
	const norm = Math.sqrt(normSquared);
	return vector.map((item) => item / norm);
}
function parseOllamaResponse(value, expected) {
	if (typeof value !== "object" || value === null || !("embeddings" in value)) throw new Error("Ollama embedding response is malformed");
	const embeddings = value.embeddings;
	if (!Array.isArray(embeddings) || embeddings.length !== expected) throw new Error(`Ollama embedding response returned ${Array.isArray(embeddings) ? embeddings.length : 0} vectors for ${expected} inputs`);
	return embeddings.map(normalizeVector);
}
function parseOpenAiResponse(value, expected) {
	if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) throw new Error("OpenAI-compatible embedding response is malformed");
	const vectors = Array.from({ length: expected });
	for (const item of value.data) {
		if (typeof item !== "object" || item === null || !("index" in item) || !("embedding" in item)) throw new Error("OpenAI-compatible embedding response contains a malformed item");
		if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= expected) throw new Error("OpenAI-compatible embedding response contains an invalid index");
		const index = item.index;
		if (vectors[index] !== void 0) throw new Error("OpenAI-compatible embedding response contains a duplicate index");
		vectors[index] = normalizeVector(item.embedding);
	}
	if (vectors.some((vector) => vector === void 0)) throw new Error(`OpenAI-compatible embedding response returned ${value.data.length} vectors for ${expected} inputs`);
	return vectors;
}
function cosine(left, right) {
	if (left.length !== right.length) throw new Error("embedding response changed vector dimensions");
	let score = 0;
	for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
	return Math.max(-1, Math.min(1, score));
}
async function readBoundedJson(response) {
	if (response.body === null) throw new Error("embedding response has no body");
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error(`embedding response exceeds ${MAX_RESPONSE_BYTES} bytes`);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new Error("embedding response is not valid JSON");
	}
}
function stableCandidateOrder(left, right) {
	const originRank = {
		registry: 0,
		cache: 1,
		remote: 2
	};
	if (originRank[left.origin] !== originRank[right.origin]) return originRank[left.origin] - originRank[right.origin];
	return `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, "en");
}
var EmbeddingRouter = class {
	options;
	vectors = /* @__PURE__ */ new Map();
	requests = 0;
	cacheHits = 0;
	cacheMisses = 0;
	constructor(options) {
		this.options = options;
	}
	stats() {
		return {
			requests: this.requests,
			cacheHits: this.cacheHits,
			cacheMisses: this.cacheMisses,
			cacheEntries: this.vectors.size
		};
	}
	async rank(query, candidates, limit, signal) {
		signal?.throwIfAborted();
		if (limit <= 0 || candidates.length === 0) return [];
		const pool = candidates.slice(0, this.options.candidateLimit);
		const texts = [boundedText(query), ...pool.map(candidateDocument)];
		if (texts[0].length === 0) return [];
		let vectors = await this.embed(texts, signal);
		const dimension = vectors[0].length;
		if (vectors.some((vector) => vector.length !== dimension)) {
			this.vectors.clear();
			vectors = await this.embed(texts, signal);
			if (vectors.some((vector) => vector.length !== vectors[0].length)) throw new Error("embedding response changed vector dimensions");
		}
		const queryVector = vectors[0];
		return pool.map((candidate, index) => ({
			candidate,
			similarity: cosine(queryVector, vectors[index + 1])
		})).filter((item) => item.similarity >= this.options.minSimilarity).sort((left, right) => right.similarity - left.similarity || stableCandidateOrder(left.candidate, right.candidate)).slice(0, limit).map(({ candidate, similarity }) => {
			const score = Math.round(similarity * 100);
			return {
				...candidate,
				score,
				selection: "embedding",
				baseScore: score,
				adaptiveBoost: 0
			};
		});
	}
	cached(key) {
		const vector = this.vectors.get(key);
		if (vector === void 0) return void 0;
		this.vectors.delete(key);
		this.vectors.set(key, vector);
		return vector;
	}
	store(key, vector) {
		this.vectors.delete(key);
		this.vectors.set(key, vector);
		while (this.vectors.size > this.options.cacheSize) {
			const oldest = this.vectors.keys().next().value;
			if (oldest === void 0) break;
			this.vectors.delete(oldest);
		}
	}
	async embed(texts, signal) {
		const keys = texts.map((text) => cacheKey(this.options, text));
		const resolved = /* @__PURE__ */ new Map();
		const missing = /* @__PURE__ */ new Map();
		for (let index = 0; index < texts.length; index += 1) {
			const key = keys[index];
			const cached = this.cached(key);
			if (cached === void 0) {
				this.cacheMisses += 1;
				missing.set(key, texts[index]);
			} else {
				this.cacheHits += 1;
				resolved.set(key, cached);
			}
		}
		const entries = [...missing.entries()];
		for (let offset = 0; offset < entries.length; offset += EMBEDDING_BATCH_SIZE) {
			const batch = entries.slice(offset, offset + EMBEDDING_BATCH_SIZE);
			const vectors = await this.request(batch.map(([, text]) => text), signal);
			for (let index = 0; index < batch.length; index += 1) {
				const key = batch[index][0];
				const vector = vectors[index];
				this.store(key, vector);
				resolved.set(key, vector);
			}
		}
		return keys.map((key) => {
			const vector = resolved.get(key);
			if (vector === void 0) throw new Error("embedding cache invariant failed");
			return vector;
		});
	}
	async request(input, signal) {
		signal?.throwIfAborted();
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const operation = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
		const apiKey = process.env[this.options.apiKeyEnv]?.trim();
		if (apiKey !== void 0 && apiKey.length > 0 && !/^[\x21-\x7E]+$/u.test(apiKey)) throw new Error(`embedding API key from ${this.options.apiKeyEnv} contains invalid header characters`);
		this.requests += 1;
		let response;
		try {
			response = await fetch(this.options.endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...apiKey === void 0 || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` }
				},
				body: JSON.stringify({
					model: this.options.model,
					input
				}),
				signal: operation
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (timeout.aborted) throw new Error(`embedding request timed out after ${this.options.timeoutMs}ms`, { cause: error });
			throw error;
		}
		signal?.throwIfAborted();
		if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
		let value;
		try {
			value = await readBoundedJson(response);
		} catch (error) {
			signal?.throwIfAborted();
			if (timeout.aborted) throw new Error(`embedding request timed out after ${this.options.timeoutMs}ms`, { cause: error });
			throw error;
		}
		signal?.throwIfAborted();
		return this.options.provider === "ollama" ? parseOllamaResponse(value, input.length) : parseOpenAiResponse(value, input.length);
	}
};
//#endregion
//#region src/router.ts
const STOP_WORDS = /* @__PURE__ */ new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"help",
	"i",
	"in",
	"is",
	"it",
	"me",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"this",
	"to",
	"use",
	"with",
	"you"
]);
const CJK_STOP_PHRASES = [
	"一个",
	"一下",
	"以及",
	"使用",
	"帮我",
	"我们",
	"我的",
	"这个",
	"那个",
	"进行",
	"需要",
	"可以",
	"如何"
];
function normalizeText(value) {
	return value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/\s+/gu, " ").trim();
}
function tokenize(value) {
	const normalized = normalizeText(value);
	const result = /* @__PURE__ */ new Set();
	for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (/^[\p{Script=Han}]+$/u.test(token)) {
			let segments = [token];
			for (const stop of CJK_STOP_PHRASES) segments = segments.flatMap((segment) => segment.split(stop).filter(Boolean));
			for (const segment of segments) {
				if (segment.length === 1) result.add(segment);
				for (let index = 0; index < segment.length - 1; index += 1) result.add(segment.slice(index, index + 2));
			}
			continue;
		}
		if (!STOP_WORDS.has(token)) result.add(token);
	}
	return result;
}
function overlap(left, right) {
	let count = 0;
	for (const value of left) if (right.has(value)) count += 1;
	return count;
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function containsNamePhrase(query, phrase) {
	if (phrase.length === 0) return false;
	return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?=$|[^\\p{L}\\p{N}])`, "u").test(query);
}
function routeScore(query, candidate) {
	const normalizedQuery = normalizeText(query);
	const exactName = normalizeText(candidate.name);
	const skillPhrase = normalizeText(candidate.name.replaceAll("-", " "));
	let score = containsNamePhrase(normalizedQuery, exactName) || containsNamePhrase(normalizedQuery, skillPhrase) ? 100 : 0;
	const queryTokens = tokenize(query);
	score += overlap(queryTokens, tokenize(candidate.name.replaceAll("-", " "))) * 20;
	if (candidate.whenToUse !== void 0) score += overlap(queryTokens, tokenize(candidate.whenToUse)) * 8;
	score += overlap(queryTokens, tokenize(candidate.description)) * 3;
	return score;
}
function ruleMatches(query, rule) {
	const normalized = normalizeText(query);
	const all = rule.matchAll ?? [];
	const any = rule.matchAny ?? [];
	const matches = (value) => {
		const term = normalizeText(value);
		return /\p{Script=Han}/u.test(term) ? normalized.includes(term) : containsNamePhrase(normalized, term);
	};
	if (all.length > 0 && !all.every(matches)) return false;
	if (any.length > 0 && !any.some(matches)) return false;
	return all.length > 0 || any.length > 0;
}
function candidateOrder(left, right) {
	if (left.score !== right.score) return right.score - left.score;
	const originRank = {
		registry: 0,
		cache: 1,
		remote: 2
	};
	if (originRank[left.origin] !== originRank[right.origin]) return originRank[left.origin] - originRank[right.origin];
	if (left.origin === "cache" && right.origin === "cache") {
		const quality = (right.qualityScore ?? 0) - (left.qualityScore ?? 0);
		if (quality !== 0) return quality;
		const installs = (right.installs ?? 0) - (left.installs ?? 0);
		if (installs !== 0) return installs;
	}
	return `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, "en");
}
function selectCandidates(query, candidates, options) {
	const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
	const selected = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rule of options.routes) {
		if (!ruleMatches(query, rule)) continue;
		for (const name of rule.skills) {
			const match = byName.get(name);
			if (match !== void 0 && !seen.has(name)) {
				selected.push({
					...match,
					score: Number.MAX_SAFE_INTEGER,
					selection: "rule",
					baseScore: Number.MAX_SAFE_INTEGER,
					adaptiveBoost: 0
				});
				seen.add(name);
			}
			if (selected.length >= options.limit) return selected;
		}
	}
	const scored = candidates.filter((candidate) => !seen.has(candidate.name)).map((candidate) => {
		const baseScore = routeScore(query, candidate);
		const adaptiveBoost = baseScore < options.minScore ? 0 : options.boosts?.get(candidate.id) ?? 0;
		return {
			...candidate,
			score: baseScore + adaptiveBoost,
			selection: "lexical",
			baseScore,
			adaptiveBoost
		};
	}).filter((candidate) => candidate.baseScore >= options.minScore).sort(candidateOrder);
	for (const candidate of scored) {
		if (seen.has(candidate.name)) continue;
		selected.push(candidate);
		seen.add(candidate.name);
		if (selected.length >= options.limit) break;
	}
	return selected;
}
function registryCandidates(skills) {
	return skills.map((summary) => ({
		id: candidateId("registry", summary.source, "", summary.name),
		origin: "registry",
		name: summary.name,
		description: summary.description,
		...summary.whenToUse === void 0 ? {} : { whenToUse: summary.whenToUse },
		source: summary.source,
		score: 0,
		summary
	}));
}
function cacheCandidates(entries) {
	return entries.map(({ manifest }) => ({
		id: candidateId("cache", manifest.source, manifest.ref, manifest.skillId),
		origin: "cache",
		name: manifest.name,
		description: manifest.description,
		...manifest.whenToUse === void 0 ? {} : { whenToUse: manifest.whenToUse },
		source: manifest.source,
		ref: manifest.ref,
		cacheId: manifest.cacheId,
		...manifest.installs === void 0 ? {} : { installs: manifest.installs },
		...manifest.qualityScore === void 0 ? {} : { qualityScore: manifest.qualityScore },
		...manifest.stars === void 0 ? {} : { stars: manifest.stars },
		...manifest.pushedAt === void 0 ? {} : { pushedAt: manifest.pushedAt },
		...manifest.discoverySources === void 0 ? {} : { discoverySources: manifest.discoverySources },
		score: 0
	}));
}
function candidateId(origin, source, ref, skillId) {
	return createHash("sha256").update(JSON.stringify([
		origin,
		source,
		ref,
		skillId
	])).digest("hex").slice(0, 24);
}
//#endregion
//#region src/remote-cache.ts
const CACHE_VERSION = 1;
const MAX_CACHE_FILE_BYTES = 4194304;
const MAX_CACHE_ENTRIES = 1e3;
const CACHE_KEY = /^[0-9a-f]{64}$/u;
const CANDIDATE_ID = /^[0-9a-f]{24}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const GITHUB_SOURCE$1 = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SKILL_NAME$1 = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
function remoteDiscoveryCacheState(ageMs, ttlMs, staleIfErrorMs) {
	if (!count$1(ageMs) || !count$1(ttlMs) || !count$1(staleIfErrorMs)) throw new Error("remote discovery cache policy inputs must be non-negative integers");
	if (ttlMs === 0) return "expired";
	if (ageMs <= ttlMs) return "fresh";
	if (staleIfErrorMs > 0 && ageMs - ttlMs <= staleIfErrorMs) return "stale";
	return "expired";
}
function boundedString$1(value, maximum) {
	return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function count$1(value, maximum = Number.MAX_SAFE_INTEGER) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function optionalCount(value) {
	return value === void 0 || count$1(value);
}
function validProviders(value) {
	return Array.isArray(value) && value.length > 0 && value.length <= 2 && value.every((provider) => provider === "skills.sh" || provider === "github") && new Set(value).size === value.length;
}
function validSkillPath(value) {
	if (value === void 0) return true;
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.includes("\\")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") && segments.at(-1)?.toLocaleLowerCase("en-US") === "skill.md";
}
function validCandidate(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	if (!(typeof item.id === "string" && CANDIDATE_ID.test(item.id) && item.origin === "remote" && boundedString$1(item.name, 128) && SKILL_NAME$1.test(item.name) && boundedString$1(item.description, 4096) && typeof item.source === "string" && GITHUB_SOURCE$1.test(item.source) && typeof item.ref === "string" && COMMIT_SHA.test(item.ref) && count$1(item.score) && item.selection === "remote-quality" && optionalCount(item.baseScore) && optionalCount(item.adaptiveBoost) && typeof item.skillId === "string" && SKILL_NAME$1.test(item.skillId) && count$1(item.installs) && validProviders(item.discoverySources) && count$1(item.qualityScore, 100) && count$1(item.relevanceScore) && count$1(item.stars) && count$1(item.forks) && (item.pushedAt === void 0 || boundedString$1(item.pushedAt, 64) && Number.isFinite(Date.parse(item.pushedAt))) && (item.license === void 0 || boundedString$1(item.license, 128)) && typeof item.recentlyActive === "boolean" && typeof item.trustedSource === "boolean" && validSkillPath(item.path) && (item.skillFileHash === void 0 || typeof item.skillFileHash === "string" && CONTENT_HASH.test(item.skillFileHash)))) return false;
	const providers = item.discoverySources;
	return item.name === item.skillId && item.id === candidateId("remote", item.source, item.ref, item.skillId) && item.score === item.qualityScore && item.baseScore === item.relevanceScore && item.adaptiveBoost === 0 && (!providers.includes("github") || typeof item.path === "string" && typeof item.skillFileHash === "string");
}
function validEntry(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return typeof item.key === "string" && CACHE_KEY.test(item.key) && count$1(item.storedAt) && Array.isArray(item.candidates) && item.candidates.length <= 25 && item.candidates.every(validCandidate);
}
function validDocument$1(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== CACHE_VERSION || !Array.isArray(document.entries) || document.entries.length > MAX_CACHE_ENTRIES || !document.entries.every(validEntry)) return false;
	return new Set(document.entries.map((entry) => entry.key)).size === document.entries.length;
}
function cloneCandidates(candidates) {
	return candidates.map((candidate) => ({
		...candidate,
		discoverySources: [...candidate.discoverySources]
	}));
}
function errorMessage$2(error) {
	return error instanceof Error ? error.message : String(error);
}
var RemoteDiscoveryCache = class {
	options;
	now;
	entries;
	loadTask;
	writeQueue = Promise.resolve();
	cacheHits = 0;
	cacheMisses = 0;
	staleHits = 0;
	writeCount = 0;
	constructor(options) {
		this.options = options;
		if (!count$1(options.ttlMs)) throw new Error("remote discovery cache ttlMs must be a non-negative integer");
		if (!count$1(options.staleIfErrorMs)) throw new Error("remote discovery cache staleIfErrorMs must be a non-negative integer");
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > MAX_CACHE_ENTRIES) throw new Error(`remote discovery cache maxEntries must be between 1 and ${MAX_CACHE_ENTRIES}`);
		this.now = options.now ?? Date.now;
	}
	get enabled() {
		return this.options.ttlMs > 0;
	}
	async get(key) {
		if (!CACHE_KEY.test(key)) throw new Error("invalid remote discovery cache key");
		if (!this.enabled) {
			this.cacheMisses += 1;
			return;
		}
		await this.writeQueue;
		const entries = await this.load();
		const entry = entries.get(key);
		if (entry === void 0) {
			this.cacheMisses += 1;
			return;
		}
		const state = remoteDiscoveryCacheState(Math.max(0, this.currentTime() - entry.storedAt), this.options.ttlMs, this.options.staleIfErrorMs);
		if (state === "fresh") {
			this.cacheHits += 1;
			return {
				state: "fresh",
				candidates: cloneCandidates(entry.candidates)
			};
		}
		if (state === "stale") {
			this.cacheMisses += 1;
			return {
				state: "stale",
				candidates: cloneCandidates(entry.candidates)
			};
		}
		entries.delete(key);
		this.cacheMisses += 1;
	}
	async put(key, candidates) {
		if (!CACHE_KEY.test(key)) throw new Error("invalid remote discovery cache key");
		if (!this.enabled) return;
		const cloned = cloneCandidates(candidates);
		if (cloned.length > 25 || !cloned.every(validCandidate)) {
			this.warn("SkillFlux skipped invalid remote discovery cache candidates.");
			return;
		}
		try {
			await this.enqueue(async (entries) => {
				entries.set(key, {
					key,
					storedAt: this.currentTime(),
					candidates: cloned
				});
			});
			this.writeCount += 1;
		} catch (error) {
			this.warn(`SkillFlux remote discovery cache write failed open: ${errorMessage$2(error)}`);
		}
	}
	recordStaleHit() {
		this.staleHits += 1;
	}
	async clear() {
		await this.writeQueue;
		const entries = await this.load();
		const removed = entries.size;
		entries.clear();
		try {
			await unlink(this.options.file);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		return removed;
	}
	async stats() {
		await this.writeQueue;
		const entries = await this.load();
		return {
			enabled: this.enabled,
			entries: entries.size,
			hits: this.cacheHits,
			misses: this.cacheMisses,
			staleHits: this.staleHits,
			writes: this.writeCount
		};
	}
	async flush() {
		await this.writeQueue;
	}
	async enqueue(update) {
		const task = this.writeQueue.then(async () => {
			const entries = await this.load();
			await update(entries);
			this.trim(entries);
			await this.save(entries);
		});
		this.writeQueue = task.catch(() => void 0);
		await task;
	}
	async load() {
		if (this.entries !== void 0) return this.entries;
		if (this.loadTask !== void 0) return await this.loadTask;
		this.loadTask = this.readDocument();
		try {
			this.entries = await this.loadTask;
			this.trim(this.entries);
			return this.entries;
		} finally {
			this.loadTask = void 0;
		}
	}
	async readDocument() {
		try {
			const metadata = await stat(this.options.file);
			if (!metadata.isFile() || metadata.size > MAX_CACHE_FILE_BYTES) {
				this.warn(`SkillFlux remote discovery cache is invalid or exceeds ${MAX_CACHE_FILE_BYTES} bytes; starting empty.`);
				return /* @__PURE__ */ new Map();
			}
			const parsed = JSON.parse(await readFile(this.options.file, "utf8"));
			if (!validDocument$1(parsed)) {
				this.warn("SkillFlux remote discovery cache failed validation; starting empty.");
				return /* @__PURE__ */ new Map();
			}
			return new Map(parsed.entries.map((entry) => [entry.key, {
				key: entry.key,
				storedAt: entry.storedAt,
				candidates: cloneCandidates(entry.candidates)
			}]));
		} catch (error) {
			if (error.code === "ENOENT") return /* @__PURE__ */ new Map();
			this.warn(`SkillFlux remote discovery cache could not be read; starting empty: ${errorMessage$2(error)}`);
			return /* @__PURE__ */ new Map();
		}
	}
	trim(entries) {
		const excess = entries.size - this.options.maxEntries;
		if (excess <= 0) return;
		const oldest = [...entries.values()].sort((left, right) => left.storedAt - right.storedAt || left.key.localeCompare(right.key, "en")).slice(0, excess);
		for (const entry of oldest) entries.delete(entry.key);
	}
	async save(entries) {
		const directory = dirname(this.options.file);
		const temporary = join(directory, `.${basename(this.options.file)}.${randomUUID()}.tmp`);
		const serialized = this.serializeWithinLimit(entries);
		await mkdir(directory, { recursive: true });
		try {
			await writeFile(temporary, serialized, {
				encoding: "utf8",
				flag: "wx"
			});
			await rename(temporary, this.options.file);
		} catch (error) {
			await unlink(temporary).catch(() => void 0);
			throw error;
		}
	}
	serializeWithinLimit(entries) {
		const prefix = `{"version":${CACHE_VERSION},"entries":[`;
		const suffix = "]}\n";
		let bytes = Buffer$1.byteLength(prefix) + Buffer$1.byteLength(suffix);
		const kept = [];
		for (const entry of [...entries.values()].sort((left, right) => right.storedAt - left.storedAt || left.key.localeCompare(right.key, "en"))) {
			const serialized = JSON.stringify(entry);
			const nextBytes = Buffer$1.byteLength(serialized) + (kept.length === 0 ? 0 : 1);
			if (bytes + nextBytes > MAX_CACHE_FILE_BYTES) continue;
			kept.push({
				entry,
				serialized
			});
			bytes += nextBytes;
		}
		const keptKeys = new Set(kept.map((item) => item.entry.key));
		for (const key of entries.keys()) if (!keptKeys.has(key)) entries.delete(key);
		return `${prefix}${kept.sort((left, right) => left.entry.key.localeCompare(right.entry.key, "en")).map((item) => item.serialized).join(",")}${suffix}`;
	}
	warn(message) {
		this.options.warn?.(message);
	}
	currentTime() {
		const value = this.now();
		if (!count$1(value)) throw new Error("remote discovery cache clock must return a non-negative safe integer");
		return value;
	}
};
//#endregion
//#region src/remote.ts
const GITHUB_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_REMOTE_SKILL_BYTES = 262144;
function boundedQuery(query) {
	return query.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().slice(0, 128);
}
function discoveryCacheKey(query, options, githubSearchEnabled) {
	return createHash("sha256").update(JSON.stringify({
		query,
		searchLimit: options.searchLimit,
		providers: options.providers,
		minQualityScore: options.minQualityScore,
		minStars: options.minStars,
		recentActivityDays: options.recentActivityDays,
		trustedOwners: options.trustedOwners,
		githubSearchEnabled
	})).digest("hex");
}
function timeoutSignal(parent, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent === void 0 ? timeout : AbortSignal.any([parent, timeout]);
}
function configuredGithubToken(explicit) {
	const token = explicit ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return token === void 0 || token.length === 0 ? void 0 : token;
}
function githubHeaders(token) {
	return {
		accept: "application/vnd.github+json",
		"user-agent": "dsh-skillflux",
		"x-github-api-version": "2022-11-28",
		...token === void 0 ? {} : { authorization: `Bearer ${token}` }
	};
}
function isSearchItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return typeof item.skillId === "string" && SKILL_NAME.test(item.skillId) && typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 4096 && typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0 && typeof item.source === "string" && GITHUB_SOURCE.test(item.source);
}
function isSkillPath(path) {
	if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\")) return false;
	const segments = path.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") && segments.at(-1)?.toLocaleLowerCase("en-US") === "skill.md";
}
function isGithubCodeSearchItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	if (typeof item.path !== "string" || !isSkillPath(item.path)) return false;
	if (typeof item.repository !== "object" || item.repository === null) return false;
	const repository = item.repository;
	return typeof repository.full_name === "string" && GITHUB_SOURCE.test(repository.full_name) && repository.private === false;
}
function isRepositoryResponse(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	const owner = item.owner;
	const license = item.license;
	return typeof item.stargazers_count === "number" && Number.isSafeInteger(item.stargazers_count) && item.stargazers_count >= 0 && typeof item.forks_count === "number" && Number.isSafeInteger(item.forks_count) && item.forks_count >= 0 && (typeof item.pushed_at === "string" || item.pushed_at === null) && typeof item.archived === "boolean" && typeof item.disabled === "boolean" && typeof item.private === "boolean" && typeof owner === "object" && owner !== null && typeof owner.type === "string" && (license === null || typeof license === "object" && typeof license.spdx_id !== "undefined");
}
function logarithmicPoints(value, multiplier, maximum) {
	return Math.min(maximum, Math.round(Math.log10(value + 1) * multiplier));
}
function activityAgeDays(pushedAt, now) {
	if (pushedAt === void 0) return void 0;
	const pushed = Date.parse(pushedAt);
	if (!Number.isFinite(pushed)) return void 0;
	return Math.max(0, (now - pushed) / 864e5);
}
function remoteQualityScore(input) {
	const relevance = input.relevanceScore >= 100 ? 55 : Math.min(50, Math.max(0, input.relevanceScore * 2));
	const adoption = logarithmicPoints(input.installs, 4, 15);
	const repository = logarithmicPoints(input.stars, 4, 15) + logarithmicPoints(input.forks, 2, 5);
	const age = activityAgeDays(input.pushedAt, input.now);
	const freshness = age === void 0 ? 0 : age <= input.recentActivityDays ? 10 : age <= input.recentActivityDays * 3 ? 6 : age <= 365 ? 3 : 0;
	const trust = (input.trustedSource ? 10 : 0) + (input.organizationOwned ? 3 : 0) + (input.hasLicense ? 2 : 0);
	return Math.min(100, relevance + adoption + repository + freshness + trust);
}
function graphqlRepository(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const item = value;
	const owner = item.owner;
	const license = item.licenseInfo;
	const branch = item.defaultBranchRef;
	if (typeof item.stargazerCount !== "number" || !Number.isSafeInteger(item.stargazerCount) || typeof item.forkCount !== "number" || !Number.isSafeInteger(item.forkCount) || typeof item.pushedAt !== "string" && item.pushedAt !== null || typeof item.isArchived !== "boolean" || typeof item.isDisabled !== "boolean" || typeof item.isPrivate !== "boolean" || typeof owner !== "object" || owner === null || typeof owner.__typename !== "string" || license !== null && (typeof license !== "object" || license === null || typeof license.spdxId !== "string" && license.spdxId !== null) || branch !== null && (typeof branch !== "object" || branch === null)) return void 0;
	if (branch !== null) {
		const target = branch.target;
		if (typeof target !== "object" || target === null || typeof target.oid !== "string") return void 0;
	}
	return item;
}
function snapshotFromGraphql(value) {
	const repository = graphqlRepository(value);
	const ref = repository?.defaultBranchRef?.target.oid;
	if (repository === void 0 || ref === void 0 || !/^[0-9a-f]{40}$/u.test(ref)) return void 0;
	const license = repository.licenseInfo?.spdxId;
	return {
		ref,
		stars: repository.stargazerCount,
		forks: repository.forkCount,
		...repository.pushedAt === null ? {} : { pushedAt: repository.pushedAt },
		archived: repository.isArchived,
		disabled: repository.isDisabled,
		private: repository.isPrivate,
		organizationOwned: repository.owner.__typename === "Organization",
		...typeof license !== "string" || license === "NOASSERTION" ? {} : { license }
	};
}
async function resolveRepositoryRest(source, signal, token) {
	const [owner, repo] = source.split("/");
	if (owner === void 0 || repo === void 0) throw new Error(`invalid GitHub source "${source}"`);
	const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const headers = githubHeaders(token);
	const [repositoryResponse, headResponse] = await Promise.all([fetch(base, {
		headers,
		signal
	}), fetch(`${base}/commits/HEAD`, {
		headers,
		signal
	})]);
	if (!repositoryResponse.ok) throw new Error(`GitHub repository lookup failed for ${source}: HTTP ${repositoryResponse.status}`);
	if (!headResponse.ok) throw new Error(`GitHub HEAD lookup failed for ${source}: HTTP ${headResponse.status}`);
	const repository = await repositoryResponse.json();
	const head = await headResponse.json();
	if (!isRepositoryResponse(repository)) throw new Error(`GitHub returned invalid repository metadata for ${source}`);
	if (typeof head.sha !== "string" || !/^[0-9a-f]{40}$/u.test(head.sha)) throw new Error(`GitHub returned an invalid HEAD for ${source}`);
	const license = repository.license?.spdx_id;
	return {
		ref: head.sha,
		stars: repository.stargazers_count,
		forks: repository.forks_count,
		...repository.pushed_at === null ? {} : { pushedAt: repository.pushed_at },
		archived: repository.archived,
		disabled: repository.disabled,
		private: repository.private,
		organizationOwned: repository.owner.type === "Organization",
		...typeof license !== "string" || license === "NOASSERTION" ? {} : { license }
	};
}
async function resolveRepositories(sources, signal, token) {
	if (sources.length === 0) return /* @__PURE__ */ new Map();
	if (token === void 0) {
		const results = await Promise.allSettled(sources.map(async (source) => ({
			source,
			snapshot: await resolveRepositoryRest(source, signal)
		})));
		signal.throwIfAborted();
		return new Map(results.flatMap((result) => result.status === "fulfilled" ? [[result.value.source, result.value.snapshot]] : []));
	}
	const fields = sources.map((source, index) => {
		const [owner, name] = source.split("/");
		return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount forkCount pushedAt isArchived isDisabled isPrivate owner { __typename } licenseInfo { spdxId } defaultBranchRef { target { ... on Commit { oid } } } }`;
	}).join("\n");
	const response = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			...githubHeaders(token),
			"content-type": "application/json"
		},
		body: JSON.stringify({ query: `query SkillFluxRepositories {\n${fields}\n}` }),
		signal
	});
	if (!response.ok) throw new Error(`GitHub repository enrichment failed: HTTP ${response.status}`);
	const payload = await response.json();
	if (typeof payload.data !== "object" || payload.data === null) throw new Error("GitHub repository enrichment returned an invalid response");
	const data = payload.data;
	const snapshots = /* @__PURE__ */ new Map();
	for (const [index, source] of sources.entries()) {
		const snapshot = snapshotFromGraphql(data[`r${index}`]);
		if (snapshot !== void 0) snapshots.set(source, snapshot);
	}
	return snapshots;
}
async function searchSkillsSh(query, limit, signal) {
	const url = new URL("https://skills.sh/api/search");
	url.searchParams.set("q", query);
	url.searchParams.set("limit", String(limit));
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": "dsh-skillflux"
		},
		signal
	});
	if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`);
	const payload = await response.json();
	if (!Array.isArray(payload.skills)) throw new Error("skills.sh returned an invalid response");
	return payload.skills.filter(isSearchItem).slice(0, limit).map((item) => ({
		source: item.source,
		skillId: item.skillId,
		name: item.skillId,
		description: item.name,
		installs: item.installs,
		discoverySources: ["skills.sh"]
	}));
}
function githubSearchTerms(query) {
	return [...tokenize(query)].filter((token) => token.length > 1).slice(0, 6).join(" ");
}
async function searchGithub(query, limit, signal, token) {
	const terms = githubSearchTerms(query);
	if (terms.length === 0) return [];
	const url = new URL("https://api.github.com/search/code");
	url.searchParams.set("q", `filename:SKILL.md ${terms}`);
	url.searchParams.set("per_page", String(limit));
	const response = await fetch(url, {
		headers: githubHeaders(token),
		signal
	});
	if (!response.ok) throw new Error(`GitHub Skill search failed: HTTP ${response.status}`);
	const payload = await response.json();
	if (!Array.isArray(payload.items)) throw new Error("GitHub Skill search returned an invalid response");
	return payload.items.filter(isGithubCodeSearchItem).slice(0, limit);
}
function rawGithubUrl(source, ref, path) {
	return `https://raw.githubusercontent.com/${source.split("/").map(encodeURIComponent).join("/")}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
async function githubSeed(hit, snapshot, signal) {
	const response = await fetch(rawGithubUrl(hit.repository.full_name, snapshot.ref, hit.path), {
		headers: {
			accept: "text/plain",
			"user-agent": "dsh-skillflux"
		},
		signal
	});
	if (!response.ok) throw new Error(`GitHub Skill fetch failed for ${hit.repository.full_name}/${hit.path}: HTTP ${response.status}`);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_SKILL_BYTES) throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`);
	const raw = await response.text();
	if (Buffer$1.byteLength(raw, "utf8") > MAX_REMOTE_SKILL_BYTES) throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`);
	const definition = parseSkillMarkdown(raw, "/skillflux-remote-preview");
	if (definition.description.length > 4096) throw new Error("remote Skill description exceeds 4096 characters");
	return {
		source: hit.repository.full_name,
		skillId: definition.name,
		name: definition.name,
		description: definition.description,
		installs: 0,
		discoverySources: ["github"],
		path: hit.path,
		skillFileHash: createHash("sha256").update(raw).digest("hex")
	};
}
function mergeSeeds(seeds, refBySource) {
	const merged = /* @__PURE__ */ new Map();
	for (const seed of seeds) {
		const ref = refBySource.get(seed.source)?.ref;
		if (ref === void 0) continue;
		const key = `${seed.source}\0${ref}\0${seed.skillId}`;
		const prior = merged.get(key);
		if (prior === void 0) {
			merged.set(key, seed);
			continue;
		}
		const discoverySources = [.../* @__PURE__ */ new Set([...prior.discoverySources, ...seed.discoverySources])];
		merged.set(key, {
			...prior,
			description: seed.discoverySources.includes("github") ? seed.description : prior.description,
			installs: Math.max(prior.installs, seed.installs),
			discoverySources,
			...prior.path === void 0 && seed.path !== void 0 ? { path: seed.path } : {},
			...prior.skillFileHash === void 0 && seed.skillFileHash !== void 0 ? { skillFileHash: seed.skillFileHash } : {}
		});
	}
	return [...merged.values()];
}
var RemoteDiscoveryClient = class {
	options;
	githubToken;
	now;
	cache;
	constructor(searchLimitOrOptions, timeoutMs) {
		const options = typeof searchLimitOrOptions === "number" ? {
			searchLimit: searchLimitOrOptions,
			timeoutMs: timeoutMs ?? 8e3
		} : searchLimitOrOptions;
		this.options = {
			searchLimit: options.searchLimit,
			timeoutMs: options.timeoutMs,
			providers: options.providers ?? ["skills.sh", "github"],
			minQualityScore: options.minQualityScore ?? 0,
			minStars: options.minStars ?? 0,
			recentActivityDays: options.recentActivityDays ?? 30,
			trustedOwners: options.trustedOwners ?? []
		};
		this.githubToken = configuredGithubToken(options.githubToken);
		this.now = options.now ?? Date.now;
		this.cache = options.cache;
	}
	get githubSearchEnabled() {
		return this.options.providers.includes("github") && this.githubToken !== void 0;
	}
	async search(query, signal) {
		const normalized = boundedQuery(query);
		if (normalized.length === 0) return [];
		signal?.throwIfAborted();
		const key = discoveryCacheKey(normalized, this.options, this.githubSearchEnabled);
		const cached = await this.cache?.get(key);
		signal?.throwIfAborted();
		if (cached?.state === "fresh") return [...cached.candidates];
		const operationSignal = timeoutSignal(signal, this.options.timeoutMs);
		try {
			const live = await this.searchLive(normalized, operationSignal);
			if (cached?.state === "stale" && live.degraded && live.candidates.length === 0) {
				this.cache?.recordStaleHit();
				return [...cached.candidates];
			}
			if (!live.degraded || cached === void 0 && live.candidates.length > 0) await this.cache?.put(key, live.candidates);
			return live.candidates;
		} catch (error) {
			signal?.throwIfAborted();
			if (cached?.state === "stale") {
				this.cache?.recordStaleHit();
				return [...cached.candidates];
			}
			throw error;
		}
	}
	async discoveryCacheStats() {
		return await this.cache?.stats();
	}
	async clearDiscoveryCache() {
		return await this.cache?.clear() ?? 0;
	}
	async searchLive(normalized, operationSignal) {
		const poolLimit = this.githubToken === void 0 ? this.options.searchLimit : Math.min(20, Math.max(this.options.searchLimit, this.options.searchLimit * 2));
		const providerTasks = [];
		if (this.options.providers.includes("skills.sh")) providerTasks.push(searchSkillsSh(normalized, poolLimit, operationSignal).then((value) => ({
			provider: "skills.sh",
			value
		})));
		if (this.options.providers.includes("github") && this.githubToken !== void 0) providerTasks.push(searchGithub(normalized, poolLimit, operationSignal, this.githubToken).then((value) => ({
			provider: "github",
			value
		})));
		if (providerTasks.length === 0) {
			if (this.options.providers.length === 1 && this.options.providers[0] === "github") throw new Error("GitHub Skill search requires GITHUB_TOKEN or GH_TOKEN");
			return {
				candidates: [],
				degraded: false
			};
		}
		const providerResults = await Promise.allSettled(providerTasks);
		operationSignal.throwIfAborted();
		const fulfilled = providerResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
		let degraded = providerResults.some((result) => result.status === "rejected");
		if (fulfilled.length === 0) {
			const rejected = providerResults.find((result) => result.status === "rejected");
			throw rejected?.reason instanceof Error ? rejected.reason : /* @__PURE__ */ new Error("remote Skill discovery failed");
		}
		const skillsSeeds = fulfilled.flatMap((result) => result.provider === "skills.sh" ? result.value : []);
		const githubHits = fulfilled.flatMap((result) => result.provider === "github" ? result.value : []);
		const sources = [.../* @__PURE__ */ new Set([...skillsSeeds.map((seed) => seed.source), ...githubHits.map((hit) => hit.repository.full_name)])];
		const snapshots = await resolveRepositories(sources, operationSignal, this.githubToken);
		if (snapshots.size < sources.length) degraded = true;
		operationSignal.throwIfAborted();
		const githubSeeds = await Promise.allSettled(githubHits.map(async (hit) => {
			const snapshot = snapshots.get(hit.repository.full_name);
			if (snapshot === void 0) throw new Error("repository metadata unavailable");
			return await githubSeed(hit, snapshot, operationSignal);
		}));
		if (githubSeeds.some((result) => result.status === "rejected")) degraded = true;
		operationSignal.throwIfAborted();
		const seeds = mergeSeeds([...skillsSeeds, ...githubSeeds.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])], snapshots);
		const trustedOwners = new Set(this.options.trustedOwners.map((owner) => owner.toLocaleLowerCase("en-US")));
		const now = this.now();
		const candidates = seeds.flatMap((seed) => {
			const snapshot = snapshots.get(seed.source);
			if (snapshot === void 0 || snapshot.archived || snapshot.disabled || snapshot.private || snapshot.stars < this.options.minStars) return [];
			const relevanceScore = routeScore(normalized, {
				name: seed.name,
				description: seed.description
			});
			if (relevanceScore === 0) return [];
			const owner = seed.source.split("/")[0]?.toLocaleLowerCase("en-US") ?? "";
			const trustedSource = trustedOwners.has(owner);
			const qualityScore = remoteQualityScore({
				relevanceScore,
				installs: seed.installs,
				stars: snapshot.stars,
				forks: snapshot.forks,
				...snapshot.pushedAt === void 0 ? {} : { pushedAt: snapshot.pushedAt },
				recentActivityDays: this.options.recentActivityDays,
				trustedSource,
				organizationOwned: snapshot.organizationOwned,
				hasLicense: snapshot.license !== void 0,
				now
			});
			if (qualityScore < this.options.minQualityScore) return [];
			const age = activityAgeDays(snapshot.pushedAt, now);
			return [{
				id: candidateId("remote", seed.source, snapshot.ref, seed.skillId),
				origin: "remote",
				name: seed.name,
				description: seed.description,
				source: seed.source,
				ref: snapshot.ref,
				score: qualityScore,
				selection: "remote-quality",
				baseScore: relevanceScore,
				adaptiveBoost: 0,
				skillId: seed.skillId,
				installs: seed.installs,
				discoverySources: seed.discoverySources,
				qualityScore,
				relevanceScore,
				stars: snapshot.stars,
				forks: snapshot.forks,
				...snapshot.pushedAt === void 0 ? {} : { pushedAt: snapshot.pushedAt },
				...snapshot.license === void 0 ? {} : { license: snapshot.license },
				recentlyActive: age !== void 0 && age <= this.options.recentActivityDays,
				trustedSource,
				...seed.path === void 0 ? {} : { path: seed.path },
				...seed.skillFileHash === void 0 ? {} : { skillFileHash: seed.skillFileHash }
			}];
		});
		candidates.sort((left, right) => right.qualityScore - left.qualityScore || right.relevanceScore - left.relevanceScore || Number(right.trustedSource) - Number(left.trustedSource) || Number(right.recentlyActive) - Number(left.recentlyActive) || right.installs - left.installs || right.stars - left.stars || `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, "en"));
		return {
			candidates: candidates.slice(0, this.options.searchLimit),
			degraded
		};
	}
};
//#endregion
//#region src/usage.ts
const USAGE_VERSION = 1;
const MAX_USAGE_FILE_BYTES = 2097152;
const MAX_USAGE_RECORDS = 5e3;
const DAY_MS = 864e5;
function boundedString(value, maximum) {
	return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function count(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value) {
	return value === void 0 || count(value);
}
function validRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return boundedString(item.candidateId, 512) && boundedString(item.name, 128) && (item.origin === "registry" || item.origin === "cache" || item.origin === "remote") && boundedString(item.source, 2048) && count(item.mounts) && count(item.uses) && timestamp(item.lastMountedAt) && timestamp(item.lastUsedAt);
}
function validDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== USAGE_VERSION || !Array.isArray(document.records)) return false;
	if (document.records.length > MAX_USAGE_RECORDS || !document.records.every(validRecord)) return false;
	return new Set(document.records.map((record) => record.candidateId)).size === document.records.length;
}
function usageOrder(left, right) {
	if (left.uses !== right.uses) return right.uses - left.uses;
	if (left.mounts !== right.mounts) return right.mounts - left.mounts;
	if ((left.lastUsedAt ?? 0) !== (right.lastUsedAt ?? 0)) return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
	if ((left.lastMountedAt ?? 0) !== (right.lastMountedAt ?? 0)) return (right.lastMountedAt ?? 0) - (left.lastMountedAt ?? 0);
	return left.candidateId.localeCompare(right.candidateId, "en");
}
function evictionOrder(left, right) {
	const leftRecent = Math.max(left.lastUsedAt ?? 0, left.lastMountedAt ?? 0);
	const rightRecent = Math.max(right.lastUsedAt ?? 0, right.lastMountedAt ?? 0);
	if (leftRecent !== rightRecent) return leftRecent - rightRecent;
	if (left.uses !== right.uses) return left.uses - right.uses;
	if (left.mounts !== right.mounts) return left.mounts - right.mounts;
	return left.candidateId.localeCompare(right.candidateId, "en");
}
function identityRecord(identity) {
	if (!validRecord({
		...identity,
		mounts: 0,
		uses: 0
	})) throw new Error("invalid SkillFlux usage identity");
	return {
		...identity,
		mounts: 0,
		uses: 0
	};
}
function increment(value) {
	return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}
var UsageStore = class {
	options;
	now;
	records;
	loadTask;
	writeQueue = Promise.resolve();
	constructor(options) {
		this.options = options;
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > MAX_USAGE_RECORDS) throw new Error(`usage maxEntries must be between 1 and ${MAX_USAGE_RECORDS}`);
		this.now = options.now ?? Date.now;
	}
	async recordMount(identity) {
		await this.enqueue(async (records) => {
			const previous = records.get(identity.candidateId) ?? identityRecord(identity);
			records.set(identity.candidateId, {
				...identityRecord(identity),
				mounts: increment(previous.mounts),
				uses: previous.uses,
				...previous.lastUsedAt === void 0 ? {} : { lastUsedAt: previous.lastUsedAt },
				lastMountedAt: this.currentTime()
			});
		});
	}
	async recordUse(identity) {
		await this.enqueue(async (records) => {
			const previous = records.get(identity.candidateId) ?? identityRecord(identity);
			records.set(identity.candidateId, {
				...identityRecord(identity),
				mounts: previous.mounts,
				uses: increment(previous.uses),
				...previous.lastMountedAt === void 0 ? {} : { lastMountedAt: previous.lastMountedAt },
				lastUsedAt: this.currentTime()
			});
		});
	}
	async list(limit = this.options.maxEntries) {
		await this.writeQueue;
		return [...(await this.load()).values()].sort(usageOrder).slice(0, Math.max(0, Math.min(limit, this.options.maxEntries))).map((record) => ({ ...record }));
	}
	async boosts(candidates, options) {
		if (!Number.isSafeInteger(options.maxBoost) || options.maxBoost < 0 || options.maxBoost > 20) throw new Error("adaptive maxBoost must be an integer from 0 to 20");
		if (!Number.isSafeInteger(options.minUses) || options.minUses < 1 || options.minUses > 1e3) throw new Error("adaptive minUses must be an integer from 1 to 1000");
		if (!Number.isFinite(options.halfLifeDays) || options.halfLifeDays < .1 || options.halfLifeDays > 3650) throw new Error("adaptive halfLifeDays must be from 0.1 to 3650");
		await this.writeQueue;
		const records = await this.load();
		const result = /* @__PURE__ */ new Map();
		const now = this.currentTime();
		for (const candidate of candidates) {
			const record = records.get(candidate.id);
			if (record === void 0 || record.uses < options.minUses || record.lastUsedAt === void 0) continue;
			const frequency = 1 - Math.exp(-record.uses / 4);
			const recency = .5 ** (Math.max(0, now - record.lastUsedAt) / DAY_MS / options.halfLifeDays);
			const boost = Math.round(options.maxBoost * frequency * recency);
			if (boost > 0) result.set(candidate.id, Math.min(boost, options.maxBoost));
		}
		return result;
	}
	async flush() {
		await this.writeQueue;
	}
	async enqueue(update) {
		const task = this.writeQueue.then(async () => {
			const records = await this.load();
			await update(records);
			this.trim(records);
			await this.save(records);
		});
		this.writeQueue = task.catch(() => void 0);
		await task;
	}
	async load() {
		if (this.records !== void 0) return this.records;
		if (this.loadTask !== void 0) return await this.loadTask;
		this.loadTask = this.readDocument();
		try {
			this.records = await this.loadTask;
			this.trim(this.records);
			return this.records;
		} finally {
			this.loadTask = void 0;
		}
	}
	async readDocument() {
		try {
			const metadata = await stat(this.options.file);
			if (!metadata.isFile() || metadata.size > MAX_USAGE_FILE_BYTES) {
				this.warn(`SkillFlux usage data is invalid or exceeds ${MAX_USAGE_FILE_BYTES} bytes; starting with empty statistics.`);
				return /* @__PURE__ */ new Map();
			}
			const parsed = JSON.parse(await readFile(this.options.file, "utf8"));
			if (!validDocument(parsed)) {
				this.warn("SkillFlux usage data failed validation; starting with empty statistics.");
				return /* @__PURE__ */ new Map();
			}
			return new Map(parsed.records.map((record) => [record.candidateId, { ...record }]));
		} catch (error) {
			if (error.code === "ENOENT") return /* @__PURE__ */ new Map();
			this.warn(`SkillFlux usage data could not be read; starting with empty statistics: ${errorMessage$1(error)}`);
			return /* @__PURE__ */ new Map();
		}
	}
	trim(records) {
		const excess = records.size - this.options.maxEntries;
		if (excess <= 0) return;
		for (const record of [...records.values()].sort(evictionOrder).slice(0, excess)) records.delete(record.candidateId);
	}
	async save(records) {
		const directory = dirname(this.options.file);
		const temporary = join(directory, `.${basename(this.options.file)}.${randomUUID()}.tmp`);
		const serialized = this.serializeWithinLimit(records);
		await mkdir(directory, { recursive: true });
		try {
			await writeFile(temporary, serialized, {
				encoding: "utf8",
				flag: "wx"
			});
			await rename(temporary, this.options.file);
		} catch (error) {
			await unlink(temporary).catch(() => void 0);
			throw error;
		}
	}
	serializeWithinLimit(records) {
		const prefix = `{"version":${USAGE_VERSION},"records":[`;
		const suffix = "]}\n";
		let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
		const kept = /* @__PURE__ */ new Map();
		for (const record of [...records.values()].sort((left, right) => evictionOrder(right, left))) {
			const serialized = JSON.stringify(record);
			const nextBytes = Buffer.byteLength(serialized) + (kept.size === 0 ? 0 : 1);
			if (bytes + nextBytes > MAX_USAGE_FILE_BYTES) continue;
			kept.set(record.candidateId, serialized);
			bytes += nextBytes;
		}
		for (const candidateId of records.keys()) if (!kept.has(candidateId)) records.delete(candidateId);
		return `${prefix}${[...kept.entries()].sort(([left], [right]) => left.localeCompare(right, "en")).map(([, serialized]) => serialized).join(",")}${suffix}`;
	}
	warn(message) {
		this.options.warn?.(message);
	}
	currentTime() {
		const value = this.now();
		if (!count(value)) throw new Error("usage clock must return a non-negative safe integer");
		return value;
	}
};
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/index.ts
const name = "skillflux";
const MOUNT_TOOL = "skillflux_mount";
const OLLAMA_EMBEDDING_ENDPOINT = "http://127.0.0.1:11434/api/embed";
const OPENAI_EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULTS = {
	maxActiveSkills: 3,
	minRouteScore: 8,
	approvalPolicy: "always",
	remoteDiscovery: "automatic",
	remoteProviders: ["skills.sh", "github"],
	remoteSearchLimit: 5,
	remoteSearchTimeoutMs: 3e4,
	remoteMinQualityScore: 35,
	remoteMinStars: 0,
	remoteRecentActivityDays: 30,
	remoteTrustedOwners: [],
	remoteCacheTtlMs: 3e5,
	remoteCacheStaleIfErrorMs: 864e5,
	remoteCacheMaxEntries: 100,
	catalogDescriptionMaxLength: 160,
	catalogTokenBudget: 0,
	maxSkillFiles: 1e3,
	maxSkillBytes: 10485760,
	installTimeoutMs: 3e5,
	routerMode: "lexical",
	embeddingProvider: "ollama",
	embeddingEndpoint: OLLAMA_EMBEDDING_ENDPOINT,
	embeddingModel: "embeddinggemma",
	embeddingApiKeyEnv: "SKILLFLUX_EMBEDDING_API_KEY",
	embeddingTimeoutMs: 5e3,
	embeddingCandidateLimit: 128,
	embeddingCacheSize: 512,
	minEmbeddingSimilarity: .45,
	usageTracking: true,
	usageMaxEntries: 1e3,
	adaptiveRouting: false,
	adaptiveMaxBoost: 6,
	adaptiveMinUses: 2,
	adaptiveHalfLifeDays: 30,
	routes: []
};
var ExpiredAgentStateError = class extends Error {
	constructor() {
		super("SkillFlux mount expired because its turn or agent lifecycle ended");
		this.name = "ExpiredAgentStateError";
	}
};
const routeRuleSchema = z.object({
	matchAll: z.array(z.string()),
	matchAny: z.array(z.string()),
	skills: z.array(z.string())
});
function positiveInteger(name, value, minimum = 1) {
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`dsh-skillflux: ${name} must be an integer greater than or equal to ${minimum}`);
	return value;
}
var CatalogBudgetExceededError = class extends Error {
	skill;
	estimatedTokens;
	budget;
	constructor(skill, estimatedTokens, budget) {
		super(`cannot mount skill "${skill}": estimated catalog size ${estimatedTokens} exceeds token budget ${budget}`);
		this.skill = skill;
		this.estimatedTokens = estimatedTokens;
		this.budget = budget;
		this.name = "CatalogBudgetExceededError";
	}
};
function boundedNumber(name, value, minimum, maximum) {
	if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`dsh-skillflux: ${name} must be between ${minimum} and ${maximum}`);
	return value;
}
function boundedInteger(name, value, minimum, maximum) {
	positiveInteger(name, value, minimum);
	if (value > maximum) throw new Error(`dsh-skillflux: ${name} must be less than or equal to ${maximum}`);
	return value;
}
function catalogTokenBudget(value) {
	if (value === 0) return value;
	return boundedInteger("catalogTokenBudget", value, 64, 1e6);
}
function remoteProviders(values) {
	const providers = [...new Set(values)];
	if (providers.length === 0) throw new Error("dsh-skillflux: remoteProviders must contain at least one provider");
	return providers;
}
function remoteTrustedOwners(values) {
	const owners = values.map((value) => value.trim()).filter((value) => value.length > 0);
	for (const owner of owners) if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) throw new Error(`dsh-skillflux: invalid GitHub owner "${owner}" in remoteTrustedOwners`);
	return [...new Set(owners.map((owner) => owner.toLocaleLowerCase("en-US")))];
}
function nonEmptyString(name, value) {
	const normalized = value.trim();
	if (normalized.length === 0) throw new Error(`dsh-skillflux: ${name} must not be empty`);
	return normalized;
}
function embeddingEndpoint(value) {
	let endpoint;
	try {
		endpoint = new URL(nonEmptyString("embeddingEndpoint", value));
	} catch {
		throw new Error("dsh-skillflux: embeddingEndpoint must be an absolute URL");
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("dsh-skillflux: embeddingEndpoint must use http or https");
	if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) throw new Error("dsh-skillflux: embeddingEndpoint must not contain credentials or a fragment");
	return endpoint.toString();
}
function environmentVariable(value) {
	const name = nonEmptyString("embeddingApiKeyEnv", value);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("dsh-skillflux: embeddingApiKeyEnv must be an environment variable name");
	return name;
}
function resolveConfig(config) {
	const embeddingProvider = config.embeddingProvider ?? DEFAULTS.embeddingProvider;
	const resolved = {
		maxActiveSkills: positiveInteger("maxActiveSkills", config.maxActiveSkills ?? DEFAULTS.maxActiveSkills),
		minRouteScore: positiveInteger("minRouteScore", config.minRouteScore ?? DEFAULTS.minRouteScore, 0),
		approvalPolicy: config.approvalPolicy ?? DEFAULTS.approvalPolicy,
		remoteDiscovery: config.remoteDiscovery ?? DEFAULTS.remoteDiscovery,
		remoteProviders: remoteProviders(config.remoteProviders ?? DEFAULTS.remoteProviders),
		remoteSearchLimit: boundedInteger("remoteSearchLimit", config.remoteSearchLimit ?? DEFAULTS.remoteSearchLimit, 1, 25),
		remoteSearchTimeoutMs: boundedInteger("remoteSearchTimeoutMs", config.remoteSearchTimeoutMs ?? DEFAULTS.remoteSearchTimeoutMs, 100, 12e4),
		remoteMinQualityScore: boundedInteger("remoteMinQualityScore", config.remoteMinQualityScore ?? DEFAULTS.remoteMinQualityScore, 0, 100),
		remoteMinStars: boundedInteger("remoteMinStars", config.remoteMinStars ?? DEFAULTS.remoteMinStars, 0, 1e7),
		remoteRecentActivityDays: boundedInteger("remoteRecentActivityDays", config.remoteRecentActivityDays ?? DEFAULTS.remoteRecentActivityDays, 1, 3650),
		remoteTrustedOwners: remoteTrustedOwners(config.remoteTrustedOwners ?? DEFAULTS.remoteTrustedOwners),
		remoteCacheTtlMs: boundedInteger("remoteCacheTtlMs", config.remoteCacheTtlMs ?? DEFAULTS.remoteCacheTtlMs, 0, 6048e5),
		remoteCacheStaleIfErrorMs: boundedInteger("remoteCacheStaleIfErrorMs", config.remoteCacheStaleIfErrorMs ?? DEFAULTS.remoteCacheStaleIfErrorMs, 0, 2592e6),
		remoteCacheMaxEntries: boundedInteger("remoteCacheMaxEntries", config.remoteCacheMaxEntries ?? DEFAULTS.remoteCacheMaxEntries, 1, 1e3),
		catalogDescriptionMaxLength: positiveInteger("catalogDescriptionMaxLength", config.catalogDescriptionMaxLength ?? DEFAULTS.catalogDescriptionMaxLength, 3),
		catalogTokenBudget: catalogTokenBudget(config.catalogTokenBudget ?? DEFAULTS.catalogTokenBudget),
		maxSkillFiles: positiveInteger("maxSkillFiles", config.maxSkillFiles ?? DEFAULTS.maxSkillFiles),
		maxSkillBytes: positiveInteger("maxSkillBytes", config.maxSkillBytes ?? DEFAULTS.maxSkillBytes),
		installTimeoutMs: positiveInteger("installTimeoutMs", config.installTimeoutMs ?? DEFAULTS.installTimeoutMs),
		routerMode: config.routerMode ?? DEFAULTS.routerMode,
		embeddingProvider,
		embeddingEndpoint: embeddingEndpoint(config.embeddingEndpoint ?? (embeddingProvider === "ollama" ? OLLAMA_EMBEDDING_ENDPOINT : OPENAI_EMBEDDING_ENDPOINT)),
		embeddingModel: nonEmptyString("embeddingModel", config.embeddingModel ?? (embeddingProvider === "ollama" ? DEFAULTS.embeddingModel : "text-embedding-3-small")),
		embeddingApiKeyEnv: environmentVariable(config.embeddingApiKeyEnv ?? DEFAULTS.embeddingApiKeyEnv),
		embeddingTimeoutMs: boundedInteger("embeddingTimeoutMs", config.embeddingTimeoutMs ?? DEFAULTS.embeddingTimeoutMs, 100, 12e4),
		embeddingCandidateLimit: boundedInteger("embeddingCandidateLimit", config.embeddingCandidateLimit ?? DEFAULTS.embeddingCandidateLimit, 1, 512),
		embeddingCacheSize: boundedInteger("embeddingCacheSize", config.embeddingCacheSize ?? DEFAULTS.embeddingCacheSize, 1, 1e4),
		minEmbeddingSimilarity: boundedNumber("minEmbeddingSimilarity", config.minEmbeddingSimilarity ?? DEFAULTS.minEmbeddingSimilarity, 0, 1),
		usageTracking: config.usageTracking ?? DEFAULTS.usageTracking,
		usageMaxEntries: boundedInteger("usageMaxEntries", config.usageMaxEntries ?? DEFAULTS.usageMaxEntries, 1, 5e3),
		adaptiveRouting: config.adaptiveRouting ?? DEFAULTS.adaptiveRouting,
		adaptiveMaxBoost: boundedInteger("adaptiveMaxBoost", config.adaptiveMaxBoost ?? DEFAULTS.adaptiveMaxBoost, 0, 20),
		adaptiveMinUses: boundedInteger("adaptiveMinUses", config.adaptiveMinUses ?? DEFAULTS.adaptiveMinUses, 1, 1e3),
		adaptiveHalfLifeDays: boundedNumber("adaptiveHalfLifeDays", config.adaptiveHalfLifeDays ?? DEFAULTS.adaptiveHalfLifeDays, .1, 3650),
		routes: config.routes ?? DEFAULTS.routes
	};
	if (resolved.adaptiveRouting && !resolved.usageTracking) throw new Error("dsh-skillflux: adaptiveRouting requires usageTracking");
	return resolved;
}
function directTask(messages) {
	const parts = [];
	for (const message of messages) {
		if (message.source.kind !== "user") continue;
		for (const block of message.content) if (block.type === "text") parts.push(block.text);
	}
	const text = parts.join("\n").trim();
	return text.length === 0 ? void 0 : text;
}
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/gu;
function invokedSkillNames(messages) {
	const names = [];
	for (const message of messages) {
		if (message.source.kind !== "user") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			for (const match of block.text.matchAll(SKILL_GESTURE)) {
				const skillName = match[2];
				if (skillName !== void 0 && !names.includes(skillName)) names.push(skillName);
			}
		}
	}
	return names;
}
function skillLookup(agent, signal) {
	return {
		...agent.session.header.cwd === void 0 ? {} : { cwd: agent.session.header.cwd },
		scope: agent,
		...signal === void 0 ? {} : { signal }
	};
}
function skillResult(definition) {
	return {
		name: definition.name,
		provider: definition.provider,
		...definition.resourceBase === void 0 ? {} : { resourceBase: { ...definition.resourceBase } },
		content: definition.content
	};
}
const skillOutputSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: {
			type: "string",
			required: true
		},
		provider: {
			type: "string",
			required: true
		},
		resourceBase: { oneOf: [
			{
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "directory"
					},
					path: {
						type: "string",
						required: true
					}
				}
			},
			{
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "url"
					},
					url: {
						type: "string",
						required: true
					}
				}
			},
			{
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "opaque"
					},
					description: {
						type: "string",
						required: true
					}
				}
			}
		] },
		content: {
			type: "string",
			required: true
		}
	}
};
var SkillFluxService = class extends Service {
	static inject = [
		"agents",
		"tools",
		"skills",
		"commands"
	];
	static Config = z.object({
		maxActiveSkills: z.number().default(DEFAULTS.maxActiveSkills),
		minRouteScore: z.number().default(DEFAULTS.minRouteScore),
		approvalPolicy: z.union([
			"always",
			"session",
			"automatic"
		]).default(DEFAULTS.approvalPolicy),
		remoteDiscovery: z.union([
			"automatic",
			"on-demand",
			"off"
		]).default(DEFAULTS.remoteDiscovery),
		remoteProviders: z.array(z.union(["skills.sh", "github"])).default([...DEFAULTS.remoteProviders]),
		remoteSearchLimit: z.number().default(DEFAULTS.remoteSearchLimit),
		remoteSearchTimeoutMs: z.number().default(DEFAULTS.remoteSearchTimeoutMs),
		remoteMinQualityScore: z.number().default(DEFAULTS.remoteMinQualityScore),
		remoteMinStars: z.number().default(DEFAULTS.remoteMinStars),
		remoteRecentActivityDays: z.number().default(DEFAULTS.remoteRecentActivityDays),
		remoteTrustedOwners: z.array(z.string()).default([]),
		remoteCacheTtlMs: z.number().default(DEFAULTS.remoteCacheTtlMs),
		remoteCacheStaleIfErrorMs: z.number().default(DEFAULTS.remoteCacheStaleIfErrorMs),
		remoteCacheMaxEntries: z.number().default(DEFAULTS.remoteCacheMaxEntries),
		catalogDescriptionMaxLength: z.number().default(DEFAULTS.catalogDescriptionMaxLength),
		catalogTokenBudget: z.number().default(DEFAULTS.catalogTokenBudget),
		maxSkillFiles: z.number().default(DEFAULTS.maxSkillFiles),
		maxSkillBytes: z.number().default(DEFAULTS.maxSkillBytes),
		installTimeoutMs: z.number().default(DEFAULTS.installTimeoutMs),
		routerMode: z.union(["lexical", "hybrid"]).default(DEFAULTS.routerMode),
		embeddingProvider: z.union(["ollama", "openai-compatible"]).default(DEFAULTS.embeddingProvider),
		embeddingEndpoint: z.string(),
		embeddingModel: z.string(),
		embeddingApiKeyEnv: z.string().default(DEFAULTS.embeddingApiKeyEnv),
		embeddingTimeoutMs: z.number().default(DEFAULTS.embeddingTimeoutMs),
		embeddingCandidateLimit: z.number().default(DEFAULTS.embeddingCandidateLimit),
		embeddingCacheSize: z.number().default(DEFAULTS.embeddingCacheSize),
		minEmbeddingSimilarity: z.number().default(DEFAULTS.minEmbeddingSimilarity),
		usageTracking: z.boolean().default(DEFAULTS.usageTracking),
		usageMaxEntries: z.number().default(DEFAULTS.usageMaxEntries),
		adaptiveRouting: z.boolean().default(DEFAULTS.adaptiveRouting),
		adaptiveMaxBoost: z.number().default(DEFAULTS.adaptiveMaxBoost),
		adaptiveMinUses: z.number().default(DEFAULTS.adaptiveMinUses),
		adaptiveHalfLifeDays: z.number().default(DEFAULTS.adaptiveHalfLifeDays),
		routes: z.array(routeRuleSchema).default([])
	});
	config;
	runtimeCtx;
	cache;
	remote;
	embedding;
	usage;
	usageTasks = /* @__PURE__ */ new Set();
	stateByAgent = /* @__PURE__ */ new WeakMap();
	states = /* @__PURE__ */ new Set();
	trustedBySession = /* @__PURE__ */ new WeakMap();
	constructor(ctx, config = {}) {
		super(ctx, "skillFlux");
		this.runtimeCtx = ctx;
		this.config = resolveConfig(config);
		this.cache = new SkillCache({
			root: dshHomePath("cache", "skillflux"),
			maxFiles: this.config.maxSkillFiles,
			maxBytes: this.config.maxSkillBytes,
			installTimeoutMs: this.config.installTimeoutMs
		});
		const discoveryCache = new RemoteDiscoveryCache({
			file: dshHomePath("storages", "skillflux", "remote-discovery.json"),
			ttlMs: this.config.remoteCacheTtlMs,
			staleIfErrorMs: this.config.remoteCacheStaleIfErrorMs,
			maxEntries: this.config.remoteCacheMaxEntries,
			warn: (message) => {
				ctx.logger.warn(message);
			}
		});
		this.remote = new RemoteDiscoveryClient({
			searchLimit: this.config.remoteSearchLimit,
			timeoutMs: this.config.remoteSearchTimeoutMs,
			providers: this.config.remoteProviders,
			minQualityScore: this.config.remoteMinQualityScore,
			minStars: this.config.remoteMinStars,
			recentActivityDays: this.config.remoteRecentActivityDays,
			trustedOwners: this.config.remoteTrustedOwners,
			cache: discoveryCache
		});
		this.usage = this.config.usageTracking ? new UsageStore({
			file: dshHomePath("storages", "skillflux", "usage.json"),
			maxEntries: this.config.usageMaxEntries,
			warn: (message) => {
				ctx.logger.warn(message);
			}
		}) : void 0;
		this.embedding = this.config.routerMode === "hybrid" ? new EmbeddingRouter({
			provider: this.config.embeddingProvider,
			endpoint: this.config.embeddingEndpoint,
			model: this.config.embeddingModel,
			apiKeyEnv: this.config.embeddingApiKeyEnv,
			timeoutMs: this.config.embeddingTimeoutMs,
			candidateLimit: this.config.embeddingCandidateLimit,
			cacheSize: this.config.embeddingCacheSize,
			minSimilarity: this.config.minEmbeddingSimilarity
		}) : void 0;
		const skillTool = this.createSkillTool();
		ctx.tools.register(skillTool);
		ctx.tools.register(this.createSearchTool());
		ctx.tools.register(this.createMountTool());
		this.registerApprovalGate(ctx);
		this.registerCommand(ctx);
		this.registerExplicitInvocation(ctx);
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject") return decision;
			signal.throwIfAborted();
			if (ctx.tools.get(skillTool.name, agent) !== skillTool) return decision;
			const active = [...this.state(agent).active.values()].map((item) => item.definition).filter(isModelInvocable).slice(0, this.config.maxActiveSkills);
			return {
				kind: "enter",
				messages: updateCatalog(agent, decision.messages, active, this.config.catalogDescriptionMaxLength)
			};
		});
		ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject" || step !== 1) return decision;
			const task = directTask(messages);
			if (task === void 0) {
				this.beginTurn(agent, turn);
				const hint = updateRemoteCandidates(agent, []);
				return hint === void 0 ? decision : {
					kind: "enter",
					messages: [...decision.messages, hint]
				};
			}
			try {
				const explicit = /* @__PURE__ */ new Set();
				for (const skillName of invokedSkillNames(messages)) {
					const definition = await ctx.skills.get(skillName, skillLookup(agent, signal));
					signal.throwIfAborted();
					if (definition !== void 0 && isUserInvocable(definition)) explicit.add(skillName);
				}
				const hint = await this.routeTurn(agent, task, turn, explicit, signal);
				return hint === void 0 ? decision : {
					kind: "enter",
					messages: [...decision.messages, hint]
				};
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExpiredAgentStateError) return decision;
				ctx.logger.warn(`SkillFlux routing failed open: ${errorMessage(error)}`);
				const hint = updateRemoteCandidates(agent, []);
				return hint === void 0 ? decision : {
					kind: "enter",
					messages: [...decision.messages, hint]
				};
			}
		});
		ctx.on("session/event", (session, event) => {
			if (event.type === "turn/end") this.cleanupSession(session);
		});
		ctx.on("session/disposed", (session) => {
			this.disposeSession(session);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			this.disposeAgent(agent);
		});
		ctx.effect(() => () => {
			for (const state of this.states) this.cleanupState(state, true);
		});
	}
	async discover(agent, query, options = {}) {
		const snapshot = await this.runtimeCtx.skills.snapshot(skillLookup(agent, options.signal));
		options.signal?.throwIfAborted();
		if (!snapshot.complete) throw new Error("SkillFlux discovery is incomplete; retry the search");
		const installed = snapshot.skills.filter(isModelInvocable);
		const cached = await this.cache.list();
		options.signal?.throwIfAborted();
		const local = dedupeByName([...registryCandidates(installed), ...cacheCandidates(cached)]);
		const selected = await this.selectLocalCandidates(query, local, this.config.remoteSearchLimit, this.config.remoteSearchLimit, options.signal);
		options.signal?.throwIfAborted();
		if (options.remote !== true || this.config.remoteDiscovery === "off") return selected;
		const remote = await this.remote.search(query, options.signal);
		options.signal?.throwIfAborted();
		return dedupeById([...selected, ...remote]).slice(0, this.config.remoteSearchLimit * 2);
	}
	async mount(agent, candidateId, signal) {
		const state = this.state(agent);
		const candidate = state.candidates.get(candidateId);
		if (candidate === void 0) throw new Error("candidate id is unknown or expired; run skillflux_search again");
		try {
			return await this.mountCandidate(state, candidate, signal);
		} catch (error) {
			if (error instanceof CatalogBudgetExceededError) {
				const trace = routingTrace(candidate, state.turn);
				if (state.lastRouting.findIndex((item) => item.candidateId === candidate.id) === -1) state.lastRouting.push({
					...trace,
					outcome: "budget-skipped"
				});
				else this.markRoutingOutcome(state, candidate.id, "budget-skipped");
			}
			throw error;
		}
	}
	unmount(agent, name) {
		const state = this.stateByAgent.get(agent);
		if (state === void 0) return;
		if (name !== void 0) {
			state.mountEpochs.set(name, (state.mountEpochs.get(name) ?? 0) + 1);
			try {
				state.disposers.get(name)?.();
			} catch (error) {
				this.runtimeCtx.logger.warn(`SkillFlux unmount failed: ${errorMessage(error)}`);
			} finally {
				state.disposers.delete(name);
				state.active.delete(name);
			}
			return;
		}
		this.cleanupState(state, false);
	}
	async reload(agent, name, signal) {
		const state = this.state(agent);
		this.unmount(agent, name);
		const generation = state.generation;
		const mountEpoch = state.mountEpochs.get(name) ?? 0;
		const candidates = await this.discover(agent, name, signal === void 0 ? {} : { signal });
		signal?.throwIfAborted();
		this.assertMountCurrent(state, generation, name, mountEpoch);
		const candidate = candidates.find((item) => item.name === name);
		if (candidate === void 0) throw new Error(`skill "${name}" was not found`);
		state.candidates.set(candidate.id, candidate);
		return await this.mountCandidate(state, candidate, signal, generation, mountEpoch);
	}
	mounted(agent) {
		return [...this.stateByAgent.get(agent)?.active.values() ?? []];
	}
	catalogStats(agent) {
		const mounted = this.mounted(agent);
		return {
			mountedSkills: mounted.length,
			estimatedTokens: estimateCatalogTokens(mounted.map((item) => item.definition), this.config.catalogDescriptionMaxLength),
			...this.config.catalogTokenBudget === 0 ? {} : { budget: this.config.catalogTokenBudget }
		};
	}
	lastRouting(agent) {
		return (this.stateByAgent.get(agent)?.lastRouting ?? []).map((trace) => ({ ...trace }));
	}
	async usageRecords(limit = 20) {
		await Promise.all(this.usageTasks);
		return await this.usage?.list(limit) ?? [];
	}
	embeddingStats() {
		return this.embedding?.stats();
	}
	async listCache() {
		return await this.cache.list();
	}
	async discoveryCacheStats() {
		return await this.remote.discoveryCacheStats();
	}
	async clearDiscoveryCache() {
		return await this.remote.clearDiscoveryCache();
	}
	async cleanCache(selector) {
		const activeIds = /* @__PURE__ */ new Set();
		for (const state of this.states) for (const item of state.active.values()) if (item.cacheId !== void 0) activeIds.add(item.cacheId);
		return await this.cache.clean(selector, activeIds);
	}
	createSkillTool() {
		return defineTool({
			name: "skill",
			description: "Load the full instructions for a skill mounted by SkillFlux for the current turn.",
			parameters: { name: {
				type: "string",
				required: true,
				description: "Exact name from the current SkillFlux catalog."
			} },
			output: {
				schema: skillOutputSchema,
				render: (_args, value) => [{
					type: "text",
					text: renderSkillContent(value)
				}]
			},
			execute: async (args, exec) => {
				if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`);
				const agent = exec.agent;
				if (agent === void 0) throw new Error("skill calls require an agent");
				const active = this.stateByAgent.get(agent)?.active.get(args.name);
				if (active === void 0) throw new Error(`skill "${args.name}" is not mounted for this turn`);
				if (!isModelInvocable(active.definition)) throw new Error(`skill "${args.name}" is not model-invocable`);
				this.trackUsage(this.usage?.recordUse(usageIdentity(active)));
				return skillResult(active.definition);
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Load skill ${args.name}`,
				kind: "read",
				rawInput: args.name
			})
		});
	}
	createSearchTool() {
		return defineTool({
			name: "skillflux_search",
			description: "Search installed, cached, and remote skills when no mounted skill clearly fits the task.",
			parameters: {
				query: {
					type: "string",
					required: true,
					description: "Concise capability query; do not include secrets."
				},
				remote: {
					type: "boolean",
					description: "Include immutable skills.sh/GitHub candidates. Defaults to true."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						query: {
							type: "string",
							required: true
						},
						candidates: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: {
										type: "string",
										required: true
									},
									origin: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									},
									description: {
										type: "string",
										required: true
									},
									source: {
										type: "string",
										required: true
									},
									ref: { type: "string" },
									installs: { type: "integer" },
									discoverySources: {
										type: "array",
										items: { type: "string" }
									},
									qualityScore: { type: "integer" },
									relevanceScore: { type: "integer" },
									stars: { type: "integer" },
									forks: { type: "integer" },
									pushedAt: { type: "string" },
									license: { type: "string" },
									recentlyActive: { type: "boolean" },
									trustedSource: { type: "boolean" },
									path: { type: "string" },
									score: {
										type: "integer",
										required: true
									},
									selection: { type: "string" },
									baseScore: { type: "integer" },
									adaptiveBoost: { type: "integer" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			execute: async (args, exec) => {
				const agent = exec.agent;
				if (agent === void 0) throw new Error("SkillFlux search requires an agent");
				const candidates = await this.discover(agent, args.query, {
					remote: args.remote !== false,
					signal: exec.signal
				});
				const state = this.state(agent);
				state.candidates.clear();
				for (const candidate of candidates) state.candidates.set(candidate.id, candidate);
				return {
					query: args.query,
					candidates: candidates.map((candidate) => ({
						id: candidate.id,
						origin: candidate.origin,
						name: candidate.name,
						description: candidate.description,
						source: candidate.source,
						..."ref" in candidate ? { ref: candidate.ref } : {},
						..."installs" in candidate && candidate.installs !== void 0 ? { installs: candidate.installs } : {},
						...candidate.origin !== "remote" ? {} : {
							discoverySources: [...candidate.discoverySources],
							qualityScore: candidate.qualityScore,
							relevanceScore: candidate.relevanceScore,
							stars: candidate.stars,
							forks: candidate.forks,
							...candidate.pushedAt === void 0 ? {} : { pushedAt: candidate.pushedAt },
							...candidate.license === void 0 ? {} : { license: candidate.license },
							recentlyActive: candidate.recentlyActive,
							trustedSource: candidate.trustedSource,
							...candidate.path === void 0 ? {} : { path: candidate.path }
						},
						score: candidate.score,
						...candidate.selection === void 0 ? {} : { selection: candidate.selection },
						...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
						...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost }
					}))
				};
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => ({
				card: "generic",
				title: "Search skills",
				kind: "read",
				rawInput: args.query
			})
		});
	}
	createMountTool() {
		return defineTool({
			name: MOUNT_TOOL,
			description: "Mount one exact candidate returned by SkillFlux search. Remote installs follow the configured approval policy.",
			parameters: { candidateId: {
				type: "string",
				required: true,
				description: "Opaque candidate id from skillflux_search."
			} },
			output: {
				schema: skillOutputSchema,
				render: (_args, value) => [{
					type: "text",
					text: renderSkillContent(value)
				}]
			},
			execute: async (args, exec) => {
				const agent = exec.agent;
				if (agent === void 0) throw new Error("SkillFlux mount requires an agent");
				return skillResult((await this.mount(agent, args.candidateId, exec.signal)).definition);
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => ({
				card: "generic",
				title: "Mount skill",
				kind: "edit",
				rawInput: args.candidateId
			})
		});
	}
	registerApprovalGate(ctx) {
		ctx.on("tools/pre-execute", async (exec, next) => {
			if (exec.name !== MOUNT_TOOL) return await next();
			const downstream = await next();
			if (downstream.kind !== "allow") return downstream;
			const agent = exec.agent;
			const id = exec.arguments.candidateId;
			if (agent === void 0 || typeof id !== "string") return {
				kind: "deny",
				reason: "invalid SkillFlux mount request"
			};
			const candidate = this.stateByAgent.get(agent)?.candidates.get(id);
			if (candidate === void 0) return {
				kind: "deny",
				reason: "SkillFlux candidate id is unknown or expired"
			};
			if (candidate.origin !== "remote" || this.config.approvalPolicy === "automatic") return downstream;
			const trusted = this.trustedBySession.get(agent.session);
			if (this.config.approvalPolicy === "session" && trusted?.has(candidate.source) === true) return downstream;
			return {
				kind: "ask",
				reason: `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`
			};
		});
	}
	registerExplicitInvocation(ctx) {
		ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject") return decision;
			const names = invokedSkillNames(messages);
			if (names.length === 0) return decision;
			const injections = [];
			for (const skillName of names) {
				const definition = await ctx.skills.get(skillName, skillLookup(agent, signal));
				signal.throwIfAborted();
				if (definition === void 0 || !isUserInvocable(definition)) continue;
				const source = {
					kind: "skill-invocation",
					name: skillName,
					form: "instructions"
				};
				injections.push(createUserMessage({
					content: [{
						type: "text",
						text: renderSkillContent(definition)
					}],
					source
				}));
			}
			return injections.length === 0 ? decision : {
				kind: "enter",
				messages: [...decision.messages, ...injections]
			};
		});
	}
	registerCommand(ctx) {
		ctx.commands.register({
			name: "skillflux",
			description: "inspect SkillFlux mounts and manage its persistent cache",
			input: { hint: "status | explain | usage | cache list | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean" },
			handler: async (invocation) => await this.executeCommand(invocation)
		});
	}
	async executeCommand(invocation) {
		const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean);
		if (parts.length === 1 && parts[0] === "status") {
			const mounted = this.mounted(invocation.agent);
			const stats = this.embeddingStats();
			const discoveryCache = await this.discoveryCacheStats();
			const catalog = this.catalogStats(invocation.agent);
			const router = this.config.routerMode === "lexical" ? "Router: lexical." : `Router: hybrid (${this.config.embeddingProvider}, ${this.config.embeddingModel}); embedding requests ${stats?.requests ?? 0}, cache ${stats?.cacheEntries ?? 0}/${this.config.embeddingCacheSize}.`;
			const telemetry = `Usage tracking: ${this.config.usageTracking ? "on" : "off"}; adaptive routing: ${this.config.adaptiveRouting ? "on" : "off"}.`;
			const catalogBudget = catalog.budget === void 0 ? "off" : String(catalog.budget);
			return {
				kind: "success",
				text: `${router}\n${telemetry}\n${`Remote discovery: ${this.config.remoteDiscovery}; providers ${this.config.remoteProviders.map((provider) => provider === "github" && !this.remote.githubSearchEnabled ? "github (token unavailable)" : provider).join(", ")}; quality >= ${this.config.remoteMinQualityScore}; stars >= ${this.config.remoteMinStars}; recent window ${this.config.remoteRecentActivityDays} days.`}\n${discoveryCache === void 0 ? "Remote discovery cache: unavailable." : `Remote discovery cache: ${discoveryCache.enabled ? "on" : "off"}; ${discoveryCache.entries}/${this.config.remoteCacheMaxEntries} entries; hits ${discoveryCache.hits}, misses ${discoveryCache.misses}, stale fallbacks ${discoveryCache.staleHits}.`}\nCatalog: ${catalog.mountedSkills} mounted, ~${catalog.estimatedTokens} estimated tokens; budget ${catalogBudget}.\n${mounted.length === 0 ? "SkillFlux: no skills are mounted for the current turn." : `SkillFlux mounted:\n${mounted.map((item) => `- ${item.name} (${item.origin}, ${item.source})`).join("\n")}`}`
			};
		}
		if (parts.length === 1 && parts[0] === "explain") {
			const traces = this.lastRouting(invocation.agent);
			return {
				kind: "success",
				text: traces.length === 0 ? "SkillFlux: no routing decision has been recorded." : `SkillFlux routing decision:\n${traces.map((trace) => {
					const base = trace.baseScore === void 0 ? "" : `, base=${trace.baseScore}`;
					const boost = trace.adaptiveBoost === void 0 ? "" : `, boost=${trace.adaptiveBoost}`;
					return `- ${trace.name} [${trace.selection}, ${trace.outcome}] score=${trace.score}${base}${boost} (${trace.origin}, ${trace.source})`;
				}).join("\n")}`
			};
		}
		if (parts.length === 1 && parts[0] === "usage") {
			const records = await this.usageRecords(20);
			return {
				kind: "success",
				text: !this.config.usageTracking ? "SkillFlux usage tracking is disabled." : records.length === 0 ? "SkillFlux has no usage statistics yet." : `SkillFlux usage (top ${records.length}):\n${records.map((record) => `- ${record.name} (${record.origin}, ${record.source}): uses ${record.uses}, mounts ${record.mounts}, last used ${formatTimestamp(record.lastUsedAt)}`).join("\n")}`
			};
		}
		if (parts.length === 2 && parts[0] === "cache" && parts[1] === "list") {
			const entries = await this.listCache();
			return {
				kind: "success",
				text: entries.length === 0 ? "SkillFlux cache is empty." : entries.map((entry) => `- ${entry.manifest.cacheId} ${entry.manifest.name} ${entry.manifest.source}@${entry.manifest.ref.slice(0, 12)} ${entry.manifest.totalBytes} bytes`).join("\n")
			};
		}
		if (parts.length === 3 && parts[0] === "cache" && parts[1] === "clean") {
			const selector = parts[2];
			if (selector === void 0 || selector !== "all" && !/^[0-9a-f]{24}$/u.test(selector)) return {
				kind: "error",
				text: "Usage: /skillflux cache clean <cache-id|all>"
			};
			const result = await this.cleanCache(selector);
			return {
				kind: "success",
				text: `Removed ${result.removed.length} cache entr${result.removed.length === 1 ? "y" : "ies"}${result.skipped.length === 0 ? "." : `; skipped active: ${result.skipped.join(", ")}.`}`
			};
		}
		if (parts.length === 2 && parts[0] === "discovery-cache" && parts[1] === "status") {
			const stats = await this.discoveryCacheStats();
			return {
				kind: "success",
				text: stats === void 0 ? "SkillFlux remote discovery cache is unavailable." : `SkillFlux remote discovery cache: ${stats.enabled ? "enabled" : "disabled"}, ${stats.entries}/${this.config.remoteCacheMaxEntries} entries, ${stats.hits} hits, ${stats.misses} misses, ${stats.staleHits} stale fallbacks, ${stats.writes} writes.`
			};
		}
		if (parts.length === 2 && parts[0] === "discovery-cache" && parts[1] === "clean") {
			const removed = await this.clearDiscoveryCache();
			return {
				kind: "success",
				text: `Removed ${removed} remote discovery cache entr${removed === 1 ? "y" : "ies"}.`
			};
		}
		return {
			kind: "error",
			text: "Usage: /skillflux status | explain | usage | cache list | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean"
		};
	}
	async routeTurn(agent, task, turn, explicit, signal) {
		const state = this.beginTurn(agent, turn);
		const generation = state.generation;
		const snapshot = await this.runtimeCtx.skills.snapshot(skillLookup(agent, signal));
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		if (!snapshot.complete) return updateRemoteCandidates(agent, []);
		const cached = await this.cache.list();
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		const localPool = [...registryCandidates(snapshot.skills.filter(isModelInvocable)), ...cacheCandidates(cached)].filter((candidate) => !explicit.has(candidate.name));
		const fallbacksByName = /* @__PURE__ */ new Map();
		for (const candidate of localPool) {
			const fallbacks = fallbacksByName.get(candidate.name) ?? [];
			fallbacks.push(candidate);
			fallbacksByName.set(candidate.name, fallbacks);
		}
		const local = dedupeByName(localPool);
		const selected = await this.selectLocalCandidates(task, local, Math.min(local.length, this.config.maxActiveSkills * 3), this.config.maxActiveSkills, signal);
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		state.lastRouting = selected.map((candidate) => routingTrace(candidate, turn));
		for (const candidate of selected) {
			if (state.active.size >= this.config.maxActiveSkills) break;
			let mounted = false;
			let budgetSkipped = false;
			for (const fallback of fallbacksByName.get(candidate.name) ?? []) try {
				await this.mountCandidate(state, {
					...fallback,
					...candidate.selection === void 0 ? {} : { selection: candidate.selection },
					...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
					...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost },
					score: candidate.score
				}, signal, generation);
				mounted = true;
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExpiredAgentStateError) throw error;
				if (error instanceof CatalogBudgetExceededError) budgetSkipped = true;
				else this.runtimeCtx.logger.warn(`SkillFlux skipped candidate ${fallback.name} from ${fallback.source}: ${errorMessage(error)}`);
			}
			if (!mounted && budgetSkipped) this.markRoutingOutcome(state, candidate.id, "budget-skipped");
		}
		if (state.active.size > 0 || this.config.remoteDiscovery !== "automatic") return updateRemoteCandidates(agent, []);
		let discoveredRemote;
		try {
			discoveredRemote = await this.remote.search(automaticDiscoveryQuery(task), signal);
			signal.throwIfAborted();
			this.assertStateCurrent(state, generation);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ExpiredAgentStateError) throw error;
			this.runtimeCtx.logger.warn(`SkillFlux remote discovery skipped: ${errorMessage(error)}`);
			return updateRemoteCandidates(agent, []);
		}
		const remote = [];
		for (const candidate of discoveredRemote) if (this.catalogFitsBudget(state, candidate)) remote.push(candidate);
		else state.lastRouting.push({
			...routingTrace(candidate, turn),
			outcome: "budget-skipped"
		});
		for (const candidate of remote) state.candidates.set(candidate.id, candidate);
		if (remote.length === 0) return updateRemoteCandidates(agent, []);
		if (this.config.approvalPolicy === "automatic") try {
			await this.mountCandidate(state, remote[0], signal, generation);
			state.candidates.clear();
			return updateRemoteCandidates(agent, []);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ExpiredAgentStateError) throw error;
			if (error instanceof CatalogBudgetExceededError) state.lastRouting.push({
				...routingTrace(remote[0], turn),
				outcome: "budget-skipped"
			});
			else this.runtimeCtx.logger.warn(`SkillFlux automatic remote mount failed: ${errorMessage(error)}`);
		}
		return updateRemoteCandidates(agent, remote);
	}
	async mountCandidate(state, candidate, signal, expectedGeneration = state.generation, expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0) {
		signal?.throwIfAborted();
		this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		const current = state.active.get(candidate.name);
		if (current !== void 0) return current;
		this.assertCapacity(state, candidate.name);
		this.assertCatalogBudget(state, candidate);
		const lookup = skillLookup(state.agent, signal);
		if (candidate.origin === "registry") {
			const definition = await this.runtimeCtx.skills.get(candidate.name, lookup);
			signal?.throwIfAborted();
			this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
			if (definition === void 0) throw new Error(`skill "${candidate.name}" is no longer available`);
			if (definition.source !== candidate.summary.source || definition.provider !== candidate.summary.provider) throw new Error(`skill candidate "${candidate.name}" expired because its provider changed; search again`);
			if (!isModelInvocable(definition)) throw new Error(`skill "${candidate.name}" is no longer model-invocable`);
			const raced = state.active.get(definition.name);
			if (raced !== void 0) return raced;
			this.assertCapacity(state, definition.name);
			this.assertCatalogBudget(state, definition);
			const mounted = {
				candidateId: candidate.id,
				name: candidate.name,
				origin: "registry",
				source: definition.source,
				selection: candidate.selection ?? "manual",
				score: candidate.score,
				...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
				...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost },
				definition
			};
			state.active.set(candidate.name, mounted);
			this.rememberRouting(state, mounted);
			this.trackUsage(this.usage?.recordMount(usageIdentity(mounted)));
			return mounted;
		}
		let entry;
		if (candidate.origin === "cache") {
			const cached = await this.cache.get(candidate.cacheId);
			signal?.throwIfAborted();
			this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
			if (cached === void 0) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`);
			entry = cached;
		} else {
			entry = await this.cache.install(candidate, signal);
			signal?.throwIfAborted();
			this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		}
		const definition = await this.cache.load(entry, signal);
		signal?.throwIfAborted();
		this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`);
		const raced = state.active.get(definition.name);
		if (raced !== void 0) return raced;
		this.assertCapacity(state, definition.name);
		this.assertCatalogBudget(state, definition);
		this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		const dispose = state.agent.ctx.skills.register({
			name: definition.name,
			description: definition.description,
			...definition.whenToUse === void 0 ? {} : { whenToUse: definition.whenToUse },
			invocation: definition.invocation,
			source: "runtime",
			provider: "skillflux-cache",
			...definition.resourceBase === void 0 ? {} : { resourceBase: definition.resourceBase },
			...definition.path === void 0 ? {} : { path: definition.path },
			...definition.metadata === void 0 ? {} : { metadata: definition.metadata },
			content: definition.content
		});
		try {
			this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		} catch (error) {
			try {
				dispose();
			} catch (disposeError) {
				this.runtimeCtx.logger.warn(`SkillFlux stale mount rollback failed: ${errorMessage(disposeError)}`);
			}
			throw error;
		}
		state.disposers.set(definition.name, dispose);
		const mounted = {
			candidateId: candidate.id,
			name: definition.name,
			origin: candidate.origin,
			source: candidate.source,
			cacheId: entry.manifest.cacheId,
			selection: candidate.selection ?? "manual",
			score: candidate.score,
			...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
			...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost },
			definition
		};
		state.active.set(definition.name, mounted);
		this.rememberRouting(state, mounted);
		this.trackUsage(this.usage?.recordMount(usageIdentity(mounted)));
		if (candidate.origin === "remote" && this.config.approvalPolicy === "session") {
			let trusted = this.trustedBySession.get(state.agent.session);
			if (trusted === void 0) {
				trusted = /* @__PURE__ */ new Set();
				this.trustedBySession.set(state.agent.session, trusted);
			}
			trusted.add(candidate.source);
		}
		return mounted;
	}
	assertCapacity(state, name) {
		if (state.active.has(name)) return;
		if (state.active.size >= this.config.maxActiveSkills) throw new Error(`cannot mount skill "${name}": the ${this.config.maxActiveSkills}-skill turn limit is reached`);
	}
	assertCatalogBudget(state, skill) {
		if (this.catalogFitsBudget(state, skill)) return;
		const estimatedTokens = estimateCatalogTokens([...[...state.active.values()].map((item) => item.definition), skill], this.config.catalogDescriptionMaxLength);
		throw new CatalogBudgetExceededError(skill.name, estimatedTokens, this.config.catalogTokenBudget);
	}
	catalogFitsBudget(state, skill) {
		if (this.config.catalogTokenBudget === 0 || state.active.has(skill.name)) return true;
		return estimateCatalogTokens([...[...state.active.values()].map((item) => item.definition), skill], this.config.catalogDescriptionMaxLength) <= this.config.catalogTokenBudget;
	}
	async selectLocalCandidates(query, candidates, limit, semanticTrigger, signal) {
		if (limit <= 0 || candidates.length === 0) return [];
		let boosts;
		if (this.config.adaptiveRouting && this.usage !== void 0) try {
			boosts = await this.usage.boosts(candidates, {
				maxBoost: this.config.adaptiveMaxBoost,
				minUses: this.config.adaptiveMinUses,
				halfLifeDays: this.config.adaptiveHalfLifeDays
			});
			signal?.throwIfAborted();
		} catch (error) {
			signal?.throwIfAborted();
			this.runtimeCtx.logger.warn(`SkillFlux adaptive routing failed open: ${errorMessage(error)}`);
		}
		const lexical = selectCandidates(query, candidates, {
			limit,
			minScore: this.config.minRouteScore,
			routes: this.config.routes,
			...boosts === void 0 ? {} : { boosts }
		});
		if (this.embedding === void 0 || lexical.length >= semanticTrigger || lexical.length >= limit) return lexical;
		const selectedNames = new Set(lexical.map((candidate) => candidate.name));
		const remaining = candidates.filter((candidate) => !selectedNames.has(candidate.name));
		try {
			const semantic = await this.embedding.rank(query, remaining, limit - lexical.length, signal);
			signal?.throwIfAborted();
			return [...lexical, ...semantic];
		} catch (error) {
			signal?.throwIfAborted();
			this.runtimeCtx.logger.warn(`SkillFlux embedding routing failed open: ${errorMessage(error)}`);
			return lexical;
		}
	}
	assertStateCurrent(state, generation) {
		if (state.generation !== generation || this.stateByAgent.get(state.agent) !== state) throw new ExpiredAgentStateError();
	}
	assertMountCurrent(state, generation, name, mountEpoch) {
		this.assertStateCurrent(state, generation);
		if ((state.mountEpochs.get(name) ?? 0) !== mountEpoch) throw new ExpiredAgentStateError();
	}
	beginTurn(agent, turn) {
		const state = this.state(agent);
		if (state.turn !== turn) {
			this.cleanupState(state, false);
			state.turn = turn;
			state.candidates.clear();
			state.lastRouting = [];
		}
		return state;
	}
	state(agent) {
		let state = this.stateByAgent.get(agent);
		if (state === void 0) {
			state = {
				agent,
				generation: 0,
				mountEpochs: /* @__PURE__ */ new Map(),
				active: /* @__PURE__ */ new Map(),
				disposers: /* @__PURE__ */ new Map(),
				candidates: /* @__PURE__ */ new Map(),
				lastRouting: []
			};
			this.stateByAgent.set(agent, state);
			this.states.add(state);
		}
		return state;
	}
	cleanupState(state, forget) {
		state.generation += 1;
		for (const dispose of [...state.disposers.values()].reverse()) try {
			dispose();
		} catch (error) {
			this.runtimeCtx.logger.warn(`SkillFlux unmount failed: ${errorMessage(error)}`);
		}
		state.disposers.clear();
		state.active.clear();
		state.mountEpochs.clear();
		if (forget) {
			state.candidates.clear();
			this.states.delete(state);
			this.stateByAgent.delete(state.agent);
		}
	}
	rememberRouting(state, mounted) {
		const trace = {
			...state.turn === void 0 ? {} : { turn: state.turn },
			candidateId: mounted.candidateId,
			name: mounted.name,
			origin: mounted.origin,
			source: mounted.source,
			selection: mounted.selection,
			outcome: "mounted",
			score: mounted.score,
			...mounted.baseScore === void 0 ? {} : { baseScore: mounted.baseScore },
			...mounted.adaptiveBoost === void 0 ? {} : { adaptiveBoost: mounted.adaptiveBoost }
		};
		const index = state.lastRouting.findIndex((item) => item.candidateId === trace.candidateId);
		if (index === -1) state.lastRouting.push(trace);
		else state.lastRouting[index] = trace;
	}
	markRoutingOutcome(state, candidateId, outcome) {
		const index = state.lastRouting.findIndex((item) => item.candidateId === candidateId);
		const trace = state.lastRouting[index];
		if (index !== -1 && trace !== void 0) state.lastRouting[index] = {
			...trace,
			outcome
		};
	}
	trackUsage(operation) {
		if (operation === void 0) return;
		let tracked;
		tracked = operation.catch((error) => {
			this.runtimeCtx.logger.warn(`SkillFlux usage tracking failed open: ${errorMessage(error)}`);
		}).finally(() => {
			this.usageTasks.delete(tracked);
		});
		this.usageTasks.add(tracked);
	}
	cleanupSession(session) {
		for (const state of this.states) {
			if (state.agent.session !== session) continue;
			this.cleanupState(state, false);
			state.candidates.clear();
		}
	}
	disposeSession(session) {
		for (const state of this.states) if (state.agent.session === session) this.cleanupState(state, true);
		this.trustedBySession.delete(session);
	}
	disposeAgent(agent) {
		const state = this.stateByAgent.get(agent);
		if (state !== void 0) this.cleanupState(state, true);
		this.stateByAgent.delete(agent);
	}
};
function dedupeById(candidates) {
	return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}
function dedupeByName(candidates) {
	const unique = /* @__PURE__ */ new Map();
	for (const candidate of candidates) if (!unique.has(candidate.name)) unique.set(candidate.name, candidate);
	return [...unique.values()];
}
function automaticDiscoveryQuery(task) {
	return [...tokenize(task)].filter((token) => token.length >= 2 && token.length <= 32 && !/^(?:sk|key|token)-?[a-z0-9]{12,}$/u.test(token)).slice(0, 12).join(" ");
}
function routingTrace(candidate, turn) {
	return {
		...turn === void 0 ? {} : { turn },
		candidateId: candidate.id,
		name: candidate.name,
		origin: candidate.origin,
		source: candidate.source,
		selection: candidate.selection ?? "manual",
		outcome: "selected",
		score: candidate.score,
		...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
		...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost }
	};
}
function usageIdentity(mounted) {
	return {
		candidateId: mounted.candidateId,
		name: mounted.name,
		origin: mounted.origin,
		source: mounted.source
	};
}
function formatTimestamp(value) {
	return value === void 0 ? "never" : new Date(value).toISOString();
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { EmbeddingRouter, RemoteDiscoveryCache, RemoteDiscoveryClient, SkillCache, SkillFluxService, SkillFluxService as default, UsageStore, estimateCatalogTokens, estimateTextTokens, inspectSkillDirectory, isLoopbackProxyFailure, name, normalizeText, parseSkillMarkdown, remoteDiscoveryCacheState, remoteQualityScore, routeScore, selectCandidates, tokenize };

//# sourceMappingURL=index.js.map