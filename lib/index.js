import { createRequire } from "node:module";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { escapeText, isModelInvocable, isSkillName, isUserInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
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
	return item.version === 1 && typeof item.cacheId === "string" && CACHE_ID.test(item.cacheId) && typeof item.source === "string" && typeof item.ref === "string" && /^[0-9a-f]{40}$/u.test(item.ref) && typeof item.skillId === "string" && typeof item.name === "string" && typeof item.description === "string" && (item.installs === void 0 || typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0) && typeof item.installedAt === "string" && typeof item.fileCount === "number" && Number.isSafeInteger(item.fileCount) && item.fileCount >= 1 && typeof item.totalBytes === "number" && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0 && typeof item.contentHash === "string" && /^[0-9a-f]{64}$/u.test(item.contentHash) && (item.whenToUse === void 0 || typeof item.whenToUse === "string");
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
		if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.source !== "string" || typeof item.ref !== "string" || typeof item.installs !== "number") return void 0;
		result.push({
			id: item.id,
			name: item.name,
			source: item.source,
			ref: item.ref,
			installs: item.installs
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
		entry.installs
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
	const lines = entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`);
	const text = update ? [
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
	return createUserMessage({
		content: [{
			type: "text",
			text
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
		installs: candidate.installs
	}));
}
function buildRemoteCandidateMessage(candidates, update) {
	const entries = candidates.map((candidate) => ({
		id: candidate.id,
		name: candidate.name,
		source: candidate.source,
		ref: candidate.ref,
		installs: candidate.installs
	}));
	const lines = entries.map((entry) => `- \`${entry.id}\` — \`${entry.name}\` from ${entry.source} @ ${entry.ref.slice(0, 12)} (${entry.installs} installs)`);
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
					score: Number.MAX_SAFE_INTEGER
				});
				seen.add(name);
			}
			if (selected.length >= options.limit) return selected;
		}
	}
	const scored = candidates.filter((candidate) => !seen.has(candidate.name)).map((candidate) => ({
		...candidate,
		score: routeScore(query, candidate)
	})).filter((candidate) => candidate.score >= options.minScore).sort(candidateOrder);
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
//#region src/remote.ts
function boundedQuery(query) {
	return query.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().slice(0, 128);
}
function timeoutSignal(parent, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent === void 0 ? timeout : AbortSignal.any([parent, timeout]);
}
function githubHeaders() {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return {
		accept: "application/vnd.github+json",
		"user-agent": "dsh-skillflux",
		"x-github-api-version": "2022-11-28",
		...token === void 0 || token.length === 0 ? {} : { authorization: `Bearer ${token}` }
	};
}
function isSearchItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	return typeof item.skillId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.skillId) && typeof item.name === "string" && item.name.trim().length > 0 && typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0 && typeof item.source === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.source);
}
async function resolveHead(source, signal) {
	const [owner, repo] = source.split("/");
	if (owner === void 0 || repo === void 0) throw new Error(`invalid GitHub source "${source}"`);
	const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/HEAD`, {
		headers: githubHeaders(),
		signal
	});
	if (!response.ok) throw new Error(`GitHub HEAD lookup failed for ${source}: HTTP ${response.status}`);
	const body = await response.json();
	if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/u.test(body.sha)) throw new Error(`GitHub returned an invalid HEAD for ${source}`);
	return body.sha;
}
var RemoteDiscoveryClient = class {
	searchLimit;
	timeoutMs;
	constructor(searchLimit, timeoutMs) {
		this.searchLimit = searchLimit;
		this.timeoutMs = timeoutMs;
	}
	async search(query, signal) {
		const normalized = boundedQuery(query);
		if (normalized.length === 0) return [];
		const operationSignal = timeoutSignal(signal, this.timeoutMs);
		const url = new URL("https://skills.sh/api/search");
		url.searchParams.set("q", normalized);
		url.searchParams.set("limit", String(this.searchLimit));
		const response = await fetch(url, {
			headers: {
				accept: "application/json",
				"user-agent": "dsh-skillflux"
			},
			signal: operationSignal
		});
		if (!response.ok) throw new Error(`skills.sh search failed: HTTP ${response.status}`);
		const payload = await response.json();
		if (!Array.isArray(payload.skills)) throw new Error("skills.sh returned an invalid response");
		const items = payload.skills.filter(isSearchItem).slice(0, this.searchLimit);
		const heads = /* @__PURE__ */ new Map();
		const head = (source) => {
			let pending = heads.get(source);
			if (pending === void 0) {
				pending = resolveHead(source, operationSignal);
				heads.set(source, pending);
			}
			return pending;
		};
		const resolved = await Promise.allSettled(items.map(async (item) => {
			const ref = await head(item.source);
			return {
				id: candidateId("remote", item.source, ref, item.skillId),
				origin: "remote",
				name: item.skillId,
				description: `${item.name} from ${item.source} (${item.installs} installs)`,
				source: item.source,
				ref,
				score: 0,
				skillId: item.skillId,
				installs: item.installs
			};
		}));
		operationSignal.throwIfAborted();
		return resolved.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
	}
};
//#endregion
//#region src/index.ts
const name = "skillflux";
const MOUNT_TOOL = "skillflux_mount";
const DEFAULTS = {
	maxActiveSkills: 3,
	minRouteScore: 8,
	approvalPolicy: "always",
	remoteDiscovery: "automatic",
	remoteSearchLimit: 5,
	remoteSearchTimeoutMs: 8e3,
	catalogDescriptionMaxLength: 160,
	maxSkillFiles: 1e3,
	maxSkillBytes: 10485760,
	installTimeoutMs: 3e5,
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
function resolveConfig(config) {
	return {
		maxActiveSkills: positiveInteger("maxActiveSkills", config.maxActiveSkills ?? DEFAULTS.maxActiveSkills),
		minRouteScore: positiveInteger("minRouteScore", config.minRouteScore ?? DEFAULTS.minRouteScore, 0),
		approvalPolicy: config.approvalPolicy ?? DEFAULTS.approvalPolicy,
		remoteDiscovery: config.remoteDiscovery ?? DEFAULTS.remoteDiscovery,
		remoteSearchLimit: positiveInteger("remoteSearchLimit", config.remoteSearchLimit ?? DEFAULTS.remoteSearchLimit),
		remoteSearchTimeoutMs: positiveInteger("remoteSearchTimeoutMs", config.remoteSearchTimeoutMs ?? DEFAULTS.remoteSearchTimeoutMs),
		catalogDescriptionMaxLength: positiveInteger("catalogDescriptionMaxLength", config.catalogDescriptionMaxLength ?? DEFAULTS.catalogDescriptionMaxLength, 3),
		maxSkillFiles: positiveInteger("maxSkillFiles", config.maxSkillFiles ?? DEFAULTS.maxSkillFiles),
		maxSkillBytes: positiveInteger("maxSkillBytes", config.maxSkillBytes ?? DEFAULTS.maxSkillBytes),
		installTimeoutMs: positiveInteger("installTimeoutMs", config.installTimeoutMs ?? DEFAULTS.installTimeoutMs),
		routes: config.routes ?? DEFAULTS.routes
	};
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
		remoteSearchLimit: z.number().default(DEFAULTS.remoteSearchLimit),
		remoteSearchTimeoutMs: z.number().default(DEFAULTS.remoteSearchTimeoutMs),
		catalogDescriptionMaxLength: z.number().default(DEFAULTS.catalogDescriptionMaxLength),
		maxSkillFiles: z.number().default(DEFAULTS.maxSkillFiles),
		maxSkillBytes: z.number().default(DEFAULTS.maxSkillBytes),
		installTimeoutMs: z.number().default(DEFAULTS.installTimeoutMs),
		routes: z.array(routeRuleSchema).default([])
	});
	config;
	runtimeCtx;
	cache;
	remote;
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
		this.remote = new RemoteDiscoveryClient(this.config.remoteSearchLimit, this.config.remoteSearchTimeoutMs);
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
		const selected = selectCandidates(query, dedupeByName([...registryCandidates(installed), ...cacheCandidates(cached)]), {
			limit: this.config.remoteSearchLimit,
			minScore: this.config.minRouteScore,
			routes: this.config.routes
		});
		if (options.remote !== true || this.config.remoteDiscovery === "off") return selected;
		const remote = await this.remote.search(query, options.signal);
		options.signal?.throwIfAborted();
		return dedupeById([...selected, ...remote]).slice(0, this.config.remoteSearchLimit * 2);
	}
	async mount(agent, candidateId, signal) {
		const state = this.state(agent);
		const candidate = state.candidates.get(candidateId);
		if (candidate === void 0) throw new Error("candidate id is unknown or expired; run skillflux_search again");
		return await this.mountCandidate(state, candidate, signal);
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
	async listCache() {
		return await this.cache.list();
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
									score: {
										type: "integer",
										required: true
									}
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
						score: candidate.score
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
			input: { hint: "status | cache list | cache clean <cache-id|all>" },
			handler: async (invocation) => await this.executeCommand(invocation)
		});
	}
	async executeCommand(invocation) {
		const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean);
		if (parts.length === 1 && parts[0] === "status") {
			const mounted = this.mounted(invocation.agent);
			return {
				kind: "success",
				text: mounted.length === 0 ? "SkillFlux: no skills are mounted for the current turn." : `SkillFlux mounted:\n${mounted.map((item) => `- ${item.name} (${item.origin}, ${item.source})`).join("\n")}`
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
		return {
			kind: "error",
			text: "Usage: /skillflux status | cache list | cache clean <cache-id|all>"
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
		const selected = selectCandidates(task, local, {
			limit: local.length,
			minScore: this.config.minRouteScore,
			routes: this.config.routes
		});
		for (const candidate of selected) {
			if (state.active.size >= this.config.maxActiveSkills) break;
			for (const fallback of fallbacksByName.get(candidate.name) ?? []) try {
				await this.mountCandidate(state, fallback, signal, generation);
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExpiredAgentStateError) throw error;
				this.runtimeCtx.logger.warn(`SkillFlux skipped candidate ${fallback.name} from ${fallback.source}: ${errorMessage(error)}`);
			}
		}
		if (state.active.size > 0 || this.config.remoteDiscovery !== "automatic") return updateRemoteCandidates(agent, []);
		let remote;
		try {
			remote = await this.remote.search(automaticDiscoveryQuery(task), signal);
			signal.throwIfAborted();
			this.assertStateCurrent(state, generation);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ExpiredAgentStateError) throw error;
			this.runtimeCtx.logger.warn(`SkillFlux remote discovery skipped: ${errorMessage(error)}`);
			return updateRemoteCandidates(agent, []);
		}
		for (const candidate of remote) state.candidates.set(candidate.id, candidate);
		if (remote.length === 0) return updateRemoteCandidates(agent, []);
		if (this.config.approvalPolicy === "automatic") try {
			await this.mountCandidate(state, remote[0], signal, generation);
			state.candidates.clear();
			return updateRemoteCandidates(agent, []);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ExpiredAgentStateError) throw error;
			this.runtimeCtx.logger.warn(`SkillFlux automatic remote mount failed: ${errorMessage(error)}`);
		}
		return updateRemoteCandidates(agent, remote);
	}
	async mountCandidate(state, candidate, signal, expectedGeneration = state.generation, expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0) {
		signal?.throwIfAborted();
		this.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		const current = state.active.get(candidate.name);
		if (current !== void 0) return current;
		this.assertCapacity(state, candidate.name);
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
			const mounted = {
				name: candidate.name,
				origin: "registry",
				source: definition.source,
				definition
			};
			state.active.set(candidate.name, mounted);
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
			name: definition.name,
			origin: candidate.origin,
			source: candidate.source,
			cacheId: entry.manifest.cacheId,
			definition
		};
		state.active.set(definition.name, mounted);
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
				candidates: /* @__PURE__ */ new Map()
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
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { RemoteDiscoveryClient, SkillCache, SkillFluxService, SkillFluxService as default, inspectSkillDirectory, isLoopbackProxyFailure, name, normalizeText, parseSkillMarkdown, routeScore, selectCandidates, tokenize };

//# sourceMappingURL=index.js.map