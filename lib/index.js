import { createRequire } from "node:module";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { access, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { lock } from "proper-lockfile";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { escapeText, isModelInvocable, isSkillName, isUserInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { Buffer as Buffer$1 } from "node:buffer";
//#region src/remote-governance.ts
const TRUST_RANK = {
	unverified: 0,
	community: 1,
	corroborated: 2,
	trusted: 3
};
function logarithmicPoints(value, multiplier, maximum) {
	return Math.min(maximum, Math.round(Math.log10(value + 1) * multiplier));
}
function activityAgeDays$1(pushedAt, now) {
	if (pushedAt === void 0) return void 0;
	const pushed = Date.parse(pushedAt);
	if (!Number.isFinite(pushed)) return void 0;
	return Math.max(0, (now - pushed) / 864e5);
}
function remoteQualityEvidence(input) {
	const relevance = input.relevanceScore >= 100 ? 55 : Math.min(50, Math.max(0, input.relevanceScore * 2));
	const adoption = logarithmicPoints(input.installs, 4, 15);
	const repository = logarithmicPoints(input.stars, 4, 15) + logarithmicPoints(input.forks, 2, 5);
	const age = activityAgeDays$1(input.pushedAt, input.now);
	const freshness = age === void 0 ? 0 : age <= input.recentActivityDays ? 10 : age <= input.recentActivityDays * 3 ? 6 : age <= 365 ? 3 : 0;
	const trust = (input.trustedSource ? 10 : 0) + (input.organizationOwned ? 3 : 0) + (input.hasLicense ? 2 : 0);
	const crossSource = (input.discoverySourceCount ?? 1) > 1;
	const contentPinned = input.contentPinned === true;
	const provenance = (crossSource ? 4 : 0) + (contentPinned ? 4 : 0);
	const total = Math.min(100, relevance + adoption + repository + freshness + trust + provenance);
	const signals = [];
	if (input.trustedSource) signals.push("trusted-owner");
	if (crossSource) signals.push("cross-source");
	if (contentPinned) signals.push("content-pinned");
	if (age !== void 0 && age <= input.recentActivityDays) signals.push("recent-activity");
	if (input.hasLicense) signals.push("declared-license");
	if (input.organizationOwned) signals.push("organization-owned");
	if (input.installs > 0) signals.push("market-adoption");
	if (input.stars > 0 || input.forks > 0) signals.push("repository-adoption");
	const warnings = [];
	if (!crossSource) warnings.push("single-source");
	if (!contentPinned) warnings.push("content-not-previewed");
	if (age === void 0) warnings.push("activity-unknown");
	else if (age > input.recentActivityDays * 3) warnings.push("stale-activity");
	if (!input.hasLicense) warnings.push("license-missing");
	if (input.installs < 10 && input.stars < 5 && input.forks < 2) warnings.push("low-adoption");
	const hasCommunityEvidence = contentPinned || input.hasLicense && freshness > 0 && (input.installs > 0 || input.stars > 0 || input.forks > 0);
	return {
		trustLevel: input.trustedSource ? "trusted" : crossSource && contentPinned ? "corroborated" : hasCommunityEvidence ? "community" : "unverified",
		breakdown: {
			relevance,
			adoption,
			repository,
			freshness,
			trust,
			provenance,
			total
		},
		signals,
		warnings
	};
}
function remoteTrustPolicyAllows(level, policy) {
	if (policy === "open") return true;
	return TRUST_RANK[level] >= TRUST_RANK[policy];
}
function compareRemoteTrust(left, right) {
	return TRUST_RANK[left] - TRUST_RANK[right];
}
function compareRemoteCandidates(left, right) {
	return right.qualityScore - left.qualityScore || right.relevanceScore - left.relevanceScore || compareRemoteTrust(right.trustLevel, left.trustLevel) || Number(right.trustedSource) - Number(left.trustedSource) || Number(right.recentlyActive) - Number(left.recentlyActive) || right.installs - left.installs || right.stars - left.stars || `${left.source}/${left.name}`.localeCompare(`${right.source}/${right.name}`, "en");
}
function deduplicateRemoteCandidates(candidates) {
	const byId = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const prior = byId.get(candidate.id);
		if (prior === void 0 || compareRemoteCandidates(candidate, prior) < 0) byId.set(candidate.id, candidate);
	}
	return [...byId.values()].sort(compareRemoteCandidates);
}
//#endregion
//#region src/approval.ts
const MOUNT_TOOL = "skillflux_mount";
const SKILL_TOOL = "skill";
function repositoryOwner(source) {
	return source.split("/")[0]?.toLocaleLowerCase("en-US") ?? "";
}
/**
* Re-evaluate persisted evidence against the current owner configuration.
* Legacy cache manifests are treated as community evidence because their
* immutable commit and complete installed-directory hash are still known.
*/
function currentCandidateTrust(candidate, config) {
	const owner = repositoryOwner(candidate.source);
	if (config.remoteTrustedOwners.includes(owner)) return "trusted";
	const sources = new Set(candidate.discoverySources ?? []);
	const contentPinned = candidate.origin === "cache" || candidate.skillFileHash !== void 0;
	if (candidate.origin === "cache" && candidate.trustLevel === void 0) return "community";
	if (candidate.trustLevel === "corroborated") return "corroborated";
	if (candidate.trustLevel === "community") return "community";
	return sources.size >= 2 && contentPinned ? "corroborated" : contentPinned ? "community" : "unverified";
}
function candidateGovernanceReason(candidate, config) {
	if (candidate.origin === "registry") return void 0;
	const owner = repositoryOwner(candidate.source);
	if (config.remoteBlockedOwners.includes(owner)) return `repository owner "${owner}" is blocked by remoteBlockedOwners`;
	const trustLevel = currentCandidateTrust(candidate, config);
	if (!remoteTrustPolicyAllows(trustLevel, config.remoteTrustPolicy)) return `candidate evidence level "${trustLevel}" does not satisfy remoteTrustPolicy "${config.remoteTrustPolicy}"`;
}
function registerApprovalGate(ctx, host) {
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (exec.name === "skillflux_mount") {
			const downstream = await next();
			if (downstream.kind !== "allow") return downstream;
			const agent = exec.agent;
			const id = exec.arguments.candidateId;
			if (agent === void 0 || typeof id !== "string") return {
				kind: "deny",
				reason: "invalid SkillFlux mount request"
			};
			const candidate = host.candidate(agent, id);
			if (candidate === void 0) return {
				kind: "deny",
				reason: "SkillFlux candidate id is unknown or expired"
			};
			const governanceReason = candidateGovernanceReason(candidate, host.config);
			if (governanceReason !== void 0) return {
				kind: "deny",
				reason: `SkillFlux mount denied: ${governanceReason}`
			};
			if (candidate.origin !== "remote" || host.config.approvalPolicy === "automatic") return downstream;
			const trusted = host.trustedBySession.get(agent.session);
			if (host.config.approvalPolicy === "session" && trusted?.has(candidate.source) === true) return downstream;
			return {
				kind: "ask",
				reason: `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`
			};
		}
		if (exec.name !== SKILL_TOOL) return await next();
		const downstream = await next();
		if (downstream.kind !== "allow") return downstream;
		const agent = exec.agent;
		if (agent === void 0) return downstream;
		const name = exec.arguments.name;
		if (typeof name !== "string" || !isSkillName(name)) return downstream;
		const candidate = host.publishedRemote(agent, name);
		if (candidate === void 0) return downstream;
		const governanceReason = candidateGovernanceReason(candidate, host.config);
		if (governanceReason !== void 0) return {
			kind: "deny",
			reason: `SkillFlux mount denied: ${governanceReason}`
		};
		if (candidate.origin !== "remote" || host.config.approvalPolicy === "automatic") return downstream;
		const trusted = host.trustedBySession.get(agent.session);
		if (host.config.approvalPolicy === "session" && trusted?.has(candidate.source) === true) return downstream;
		return {
			kind: "ask",
			reason: `Install remote skill ${candidate.skillId} from ${candidate.source} at immutable commit ${candidate.ref}?`
		};
	});
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
/**
* Chinese has no word boundaries, so bigram overlap alone under-scores a
* short query whose terms appear verbatim inside a longer description. A
* literal CJK fragment in the description is a strong relevance signal.
*/
function cjkSubstringBonus(queryTokens, text) {
	let bonus = 0;
	for (const token of queryTokens) if (/^[\p{Script=Han}]{2,}$/u.test(token) && text.includes(token)) bonus += 10;
	return bonus;
}
function routeScore(query, candidate) {
	const normalizedQuery = normalizeText(query);
	const exactName = normalizeText(candidate.name);
	const skillPhrase = normalizeText(candidate.name.replaceAll("-", " "));
	let score = containsNamePhrase(normalizedQuery, exactName) || containsNamePhrase(normalizedQuery, skillPhrase) ? 100 : 0;
	const queryTokens = tokenize(query);
	score += overlap(queryTokens, tokenize(candidate.name.replaceAll("-", " "))) * 20;
	if (candidate.whenToUse !== void 0) {
		score += overlap(queryTokens, tokenize(candidate.whenToUse)) * 8;
		score += cjkSubstringBonus(queryTokens, candidate.whenToUse);
	}
	score += overlap(queryTokens, tokenize(candidate.description)) * 3;
	score += cjkSubstringBonus(queryTokens, candidate.description);
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
		...manifest.trustLevel === void 0 ? {} : { trustLevel: manifest.trustLevel },
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
//#region src/state.ts
var ExpiredAgentStateError = class extends Error {
	constructor() {
		super("SkillFlux mount expired because its turn or agent lifecycle ended");
		this.name = "ExpiredAgentStateError";
	}
};
function skillLookup(agent, signal) {
	return {
		...agent.session.header.cwd === void 0 ? {} : { cwd: agent.session.header.cwd },
		scope: agent,
		...signal === void 0 ? {} : { signal }
	};
}
var TurnStateRegistry = class {
	warn;
	stateByAgent = /* @__PURE__ */ new WeakMap();
	states = /* @__PURE__ */ new Set();
	constructor(warn) {
		this.warn = warn;
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
				published: {
					candidates: [],
					complete: true
				},
				lastRouting: []
			};
			this.stateByAgent.set(agent, state);
			this.states.add(state);
		}
		return state;
	}
	peek(agent) {
		return this.stateByAgent.get(agent);
	}
	candidate(agent, candidateId) {
		return this.stateByAgent.get(agent)?.candidates.get(candidateId);
	}
	active(agent, name) {
		return this.stateByAgent.get(agent)?.active.get(name);
	}
	mounted(agent) {
		return [...this.stateByAgent.get(agent)?.active.values() ?? []];
	}
	lastRouting(agent) {
		return (this.stateByAgent.get(agent)?.lastRouting ?? []).map((trace) => ({ ...trace }));
	}
	beginTurn(agent, turn) {
		const state = this.state(agent);
		if (state.turn !== turn) {
			this.cleanupState(state, false);
			state.turn = turn;
			state.candidates.clear();
			state.published = {
				candidates: [],
				complete: true
			};
			state.lastRouting = [];
		}
		return state;
	}
	cleanupState(state, forget) {
		state.generation += 1;
		for (const dispose of [...state.disposers.values()].reverse()) try {
			dispose();
		} catch (error) {
			this.warn(`SkillFlux unmount failed: ${errorMessage$6(error)}`);
		}
		state.disposers.clear();
		state.active.clear();
		state.mountEpochs.clear();
		state.published = {
			candidates: [],
			complete: true
		};
		if (forget) {
			state.candidates.clear();
			this.states.delete(state);
			this.stateByAgent.delete(state.agent);
		}
	}
	cleanupAll() {
		for (const state of this.states) this.cleanupState(state, true);
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
	}
	disposeAgent(agent) {
		const state = this.stateByAgent.get(agent);
		const session = state?.agent.session;
		if (state !== void 0) this.cleanupState(state, true);
		this.stateByAgent.delete(agent);
		if (session !== void 0 && ![...this.states].some((item) => item.agent.session === session)) return session;
	}
	assertStateCurrent(state, generation) {
		if (state.generation !== generation || this.stateByAgent.get(state.agent) !== state) throw new ExpiredAgentStateError();
	}
	assertMountCurrent(state, generation, name, mountEpoch) {
		this.assertStateCurrent(state, generation);
		if ((state.mountEpochs.get(name) ?? 0) !== mountEpoch) throw new ExpiredAgentStateError();
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
	activeCacheIds() {
		const activeIds = /* @__PURE__ */ new Set();
		for (const state of this.states) for (const item of state.active.values()) if (item.cacheId !== void 0) activeIds.add(item.cacheId);
		return activeIds;
	}
};
function errorMessage$6(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/activation.ts
function usageIdentity(mounted) {
	return {
		candidateId: mounted.candidateId,
		name: mounted.name,
		origin: mounted.origin,
		source: mounted.source,
		...mounted.cacheId === void 0 ? {} : { cacheId: mounted.cacheId }
	};
}
async function activateCandidate(host, state, candidate, signal, expectedGeneration = state.generation, expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0) {
	signal?.throwIfAborted();
	host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
	const governanceReason = candidateGovernanceReason(candidate, host.config);
	if (governanceReason !== void 0) throw new Error(`SkillFlux mount denied: ${governanceReason}`);
	const current = state.active.get(candidate.name);
	if (current !== void 0) return current;
	host.assertCapacity(state, candidate.name);
	host.assertCatalogBudget(state, candidate);
	const lookup = skillLookup(state.agent, signal);
	if (candidate.origin === "registry") {
		const definition = await host.runtimeCtx.skills.get(candidate.name, lookup);
		signal?.throwIfAborted();
		host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		if (definition === void 0) throw new Error(`skill "${candidate.name}" is no longer available`);
		if (definition.source !== candidate.summary.source || definition.provider !== candidate.summary.provider) throw new Error(`skill candidate "${candidate.name}" expired because its provider changed; search again`);
		if (!isModelInvocable(definition)) throw new Error(`skill "${candidate.name}" is no longer model-invocable`);
		const raced = state.active.get(definition.name);
		if (raced !== void 0) return raced;
		host.assertCapacity(state, definition.name);
		host.assertCatalogBudget(state, definition);
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
		host.rememberRouting(state, mounted);
		host.trackUsage(host.usage?.recordMount(usageIdentity(mounted)));
		return mounted;
	}
	const releaseLease = await host.acquireCacheLease();
	const cacheSignal = releaseLease.signal === void 0 ? signal : signal === void 0 ? releaseLease.signal : AbortSignal.any([signal, releaseLease.signal]);
	try {
		let entry;
		if (candidate.origin === "cache") {
			const cached = await host.cache.get(candidate.cacheId);
			cacheSignal?.throwIfAborted();
			host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
			if (cached === void 0) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`);
			const currentCachedCandidate = cacheCandidates([cached])[0];
			if (currentCachedCandidate === void 0) throw new Error(`cache entry "${candidate.cacheId}" is invalid`);
			const currentGovernanceReason = candidateGovernanceReason(currentCachedCandidate, host.config);
			if (currentGovernanceReason !== void 0) throw new Error(`SkillFlux mount denied: ${currentGovernanceReason}`);
			entry = cached;
		} else {
			entry = await host.cache.install(candidate, cacheSignal);
			cacheSignal?.throwIfAborted();
			host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		}
		const definition = await host.cache.load(entry, cacheSignal);
		cacheSignal?.throwIfAborted();
		host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`);
		const raced = state.active.get(definition.name);
		if (raced !== void 0) {
			await releaseLease();
			cacheSignal?.throwIfAborted();
			host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
			if (state.active.get(raced.name) !== raced) throw new ExpiredAgentStateError();
			return raced;
		}
		host.assertCapacity(state, definition.name);
		host.assertCatalogBudget(state, definition);
		host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		const releaseActiveLease = await host.cache.createActiveLease(entry.manifest.cacheId);
		try {
			cacheSignal?.throwIfAborted();
			host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
		} catch (error) {
			await host.trackActiveLeaseCleanup(releaseActiveLease);
			throw error;
		}
		let dispose;
		try {
			dispose = host.runtimeCtx.skills.register({
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
		} catch (error) {
			await host.trackActiveLeaseCleanup(releaseActiveLease);
			throw error;
		}
		let activeCleanupTask;
		let runtimeDisposed = false;
		const disposeMounted = () => {
			if (runtimeDisposed) return;
			runtimeDisposed = true;
			try {
				dispose();
			} finally {
				activeCleanupTask = host.trackActiveLeaseCleanup(releaseActiveLease);
			}
		};
		state.disposers.set(definition.name, disposeMounted);
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
		try {
			await releaseLease();
			cacheSignal?.throwIfAborted();
			host.assertMountCurrent(state, expectedGeneration, candidate.name, expectedMountEpoch);
			if (state.active.get(mounted.name) !== mounted) throw new ExpiredAgentStateError();
		} catch (error) {
			if (state.active.get(mounted.name) === mounted) {
				state.active.delete(mounted.name);
				if (state.disposers.get(mounted.name) === disposeMounted) state.disposers.delete(mounted.name);
				try {
					disposeMounted();
				} catch (disposeError) {
					host.runtimeCtx.logger.warn(`SkillFlux cancelled mount rollback failed: ${errorMessage$5(disposeError)}`);
				}
				if (activeCleanupTask !== void 0) await activeCleanupTask;
			}
			throw error;
		}
		host.rememberRouting(state, mounted);
		host.trackUsage(host.usage?.recordMount(usageIdentity(mounted)));
		if (candidate.origin === "remote") {
			host.cachePruneSessions.add(state.agent.session);
			host.scheduleAutoPrune();
			if (host.config.approvalPolicy === "session") {
				let trusted = host.trustedBySession.get(state.agent.session);
				if (trusted === void 0) {
					trusted = /* @__PURE__ */ new Set();
					host.trustedBySession.set(state.agent.session, trusted);
				}
				trusted.add(candidate.source);
			}
		}
		return mounted;
	} finally {
		await releaseLease();
	}
}
function errorMessage$5(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
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
//#region src/cache-governance.ts
function evidenceKey(source, name) {
	return JSON.stringify([source, name]);
}
function safeTimestamp(value) {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function safeSum(left, right) {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
function validCount(value) {
	return Number.isSafeInteger(value) && value >= 0;
}
function validateEvidence(item) {
	if (typeof item.source !== "string" || item.source.length === 0 || item.source.length > 2048 || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 128 || !validCount(item.mounts) || !validCount(item.uses) || item.cacheId !== void 0 && !/^[0-9a-f]{24}$/u.test(item.cacheId) || item.lastMountedAt !== void 0 && !validCount(item.lastMountedAt) || item.lastUsedAt !== void 0 && !validCount(item.lastUsedAt)) throw new Error("invalid cache usage evidence");
}
function mergeEvidence(previous, item) {
	if (item === void 0) return previous;
	if (previous === void 0) return item;
	const lastMountedAt = Math.max(previous.lastMountedAt ?? 0, item.lastMountedAt ?? 0);
	const lastUsedAt = Math.max(previous.lastUsedAt ?? 0, item.lastUsedAt ?? 0);
	return {
		source: item.source,
		name: item.name,
		...item.cacheId === void 0 ? {} : { cacheId: item.cacheId },
		mounts: safeSum(previous.mounts, item.mounts),
		uses: safeSum(previous.uses, item.uses),
		...lastMountedAt === 0 ? {} : { lastMountedAt },
		...lastUsedAt === 0 ? {} : { lastUsedAt }
	};
}
function aggregateEvidence(items) {
	const exact = /* @__PURE__ */ new Map();
	const legacy = /* @__PURE__ */ new Map();
	for (const item of items) {
		validateEvidence(item);
		if (item.cacheId !== void 0) exact.set(item.cacheId, mergeEvidence(exact.get(item.cacheId), item));
		else {
			const key = evidenceKey(item.source, item.name);
			legacy.set(key, mergeEvidence(legacy.get(key), item));
		}
	}
	return {
		exact,
		legacy
	};
}
function evictionOrder$1(left, right) {
	if (left.uses !== right.uses) return left.uses - right.uses;
	if (left.mounts !== right.mounts) return left.mounts - right.mounts;
	if (left.lastActivityAt !== right.lastActivityAt) return left.lastActivityAt - right.lastActivityAt;
	if ((left.entry.manifest.qualityScore ?? 0) !== (right.entry.manifest.qualityScore ?? 0)) return (left.entry.manifest.qualityScore ?? 0) - (right.entry.manifest.qualityScore ?? 0);
	if ((left.entry.manifest.installs ?? 0) !== (right.entry.manifest.installs ?? 0)) return (left.entry.manifest.installs ?? 0) - (right.entry.manifest.installs ?? 0);
	return left.entry.manifest.cacheId.localeCompare(right.entry.manifest.cacheId, "en");
}
function limitReason(entries, bytes, policy) {
	const overEntries = entries > policy.maxEntries;
	const overBytes = bytes > policy.maxTotalBytes;
	if (overEntries && overBytes) return "entry-and-byte-limit";
	return overEntries ? "entry-limit" : "byte-limit";
}
function validatePolicy(policy) {
	if (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 1) throw new Error("cache prune maxEntries must be a positive safe integer");
	if (!Number.isSafeInteger(policy.maxTotalBytes) || policy.maxTotalBytes < 1) throw new Error("cache prune maxTotalBytes must be a positive safe integer");
	if (!Number.isSafeInteger(policy.maxIdleMs) || policy.maxIdleMs < 0) throw new Error("cache prune maxIdleMs must be a non-negative safe integer");
}
function planCachePrune(entries, evidence, policy, active = /* @__PURE__ */ new Set(), now = Date.now()) {
	validatePolicy(policy);
	if (!Number.isSafeInteger(now) || now < 0) throw new Error("cache prune clock must be a non-negative safe integer");
	const usage = aggregateEvidence(evidence);
	const newestBySkill = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = evidenceKey(entry.manifest.source, entry.manifest.name);
		const previous = newestBySkill.get(key);
		if (previous === void 0 || safeTimestamp(entry.manifest.installedAt) > safeTimestamp(previous.manifest.installedAt) || entry.manifest.installedAt === previous.manifest.installedAt && entry.manifest.cacheId.localeCompare(previous.manifest.cacheId, "en") > 0) newestBySkill.set(key, entry);
	}
	const ranked = entries.map((entry) => {
		const installedAt = safeTimestamp(entry.manifest.installedAt);
		const key = evidenceKey(entry.manifest.source, entry.manifest.name);
		const legacy = newestBySkill.get(key)?.manifest.cacheId === entry.manifest.cacheId ? usage.legacy.get(key) : void 0;
		const item = mergeEvidence(usage.exact.get(entry.manifest.cacheId), legacy);
		return {
			entry,
			mounts: item?.mounts ?? 0,
			uses: item?.uses ?? 0,
			lastActivityAt: Math.min(now, Math.max(installedAt, item?.lastMountedAt ?? 0, item?.lastUsedAt ?? 0))
		};
	});
	const protectedEntries = ranked.filter((item) => active.has(item.entry.manifest.cacheId));
	const removable = ranked.filter((item) => !active.has(item.entry.manifest.cacheId)).sort(evictionOrder$1);
	const decisions = [];
	const removed = /* @__PURE__ */ new Set();
	let remainingEntries = entries.length;
	let remainingBytes = entries.reduce((total, entry) => safeSum(total, entry.manifest.totalBytes), 0);
	if (policy.maxIdleMs > 0) for (const item of removable) {
		if (Math.max(0, now - item.lastActivityAt) < policy.maxIdleMs) continue;
		const id = item.entry.manifest.cacheId;
		decisions.push({
			cacheId: id,
			reason: "idle"
		});
		removed.add(id);
		remainingEntries -= 1;
		remainingBytes -= item.entry.manifest.totalBytes;
	}
	for (const item of removable) {
		if (remainingEntries <= policy.maxEntries && remainingBytes <= policy.maxTotalBytes) break;
		const id = item.entry.manifest.cacheId;
		if (removed.has(id)) continue;
		decisions.push({
			cacheId: id,
			reason: limitReason(remainingEntries, remainingBytes, policy)
		});
		removed.add(id);
		remainingEntries -= 1;
		remainingBytes -= item.entry.manifest.totalBytes;
	}
	return {
		decisions,
		protected: protectedEntries.map((item) => item.entry.manifest.cacheId).sort((left, right) => left.localeCompare(right, "en")),
		beforeEntries: entries.length,
		beforeBytes: entries.reduce((total, entry) => safeSum(total, entry.manifest.totalBytes), 0),
		afterEntries: remainingEntries,
		afterBytes: remainingBytes
	};
}
//#endregion
//#region src/remote-source.ts
const MAX_REMOTE_SKILL_BYTES$1 = 262144;
const MAX_REPOSITORY_SKILL_FILES = 512;
const MAX_REPOSITORY_TREE_ITEMS = 1e5;
const MAX_REPOSITORY_PATH_LENGTH = 4096;
const FETCH_CONCURRENCY = 8;
function githubToken() {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return token === void 0 || token.length === 0 ? void 0 : token;
}
function githubHeaders$1() {
	const token = githubToken();
	return {
		accept: "application/vnd.github+json",
		"user-agent": "dsh-skillflux",
		"x-github-api-version": "2022-11-28",
		...token === void 0 ? {} : { authorization: `Bearer ${token}` }
	};
}
function repositoryUrl(candidate, suffix) {
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(candidate.source);
	if (match === null) throw new Error("remote candidate source is not a GitHub repository");
	const owner = match[1];
	const repository = match[2];
	return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}${suffix}`;
}
function assertPinnedCandidate(candidate) {
	repositoryUrl(candidate, "");
	if (!/^[0-9a-f]{40}$/u.test(candidate.ref)) throw new Error("remote candidate is not pinned to an immutable Git commit");
}
function isTreeItem(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	if (typeof item.path !== "string" || item.path.length === 0 || item.path.length > MAX_REPOSITORY_PATH_LENGTH || item.path.startsWith("/") || item.path.includes("\\") || item.path.includes("\0") || item.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") || typeof item.sha !== "string" || !/^[0-9a-f]{40}$/u.test(item.sha)) return false;
	if (item.type === "blob") return (item.mode === "100644" || item.mode === "100755" || item.mode === "120000") && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0;
	if (item.type === "tree") return item.mode === "040000";
	return item.type === "commit" && item.mode === "160000";
}
function decodeGithubBlob(payload, expectedSha, maxBytes) {
	if (payload.encoding !== "base64" || typeof payload.content !== "string" || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > maxBytes || payload.sha !== expectedSha) throw new Error("GitHub Skill download returned an invalid blob");
	const encoded = payload.content.replaceAll(/\s/gu, "");
	if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("GitHub Skill download returned invalid base64 content");
	const bytes = Buffer$1.from(encoded, "base64");
	if (bytes.length !== payload.size || bytes.length > maxBytes) throw new Error("GitHub Skill download returned an invalid blob size");
	if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expectedSha) throw new Error("GitHub Skill download does not match its tree blob SHA");
	return bytes;
}
async function fetchBlob(candidate, path, sha, maxBytes, signal) {
	const response = await fetch(repositoryUrl(candidate, `/git/blobs/${sha}`), {
		headers: githubHeaders$1(),
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw new Error(`GitHub Skill download failed for ${candidate.source}/${path}: HTTP ${response.status}`);
	return decodeGithubBlob(await response.json(), sha, maxBytes);
}
async function fetchSkill(candidate, path, sha, signal) {
	const bytes = await fetchBlob(candidate, path, sha, MAX_REMOTE_SKILL_BYTES$1, signal);
	try {
		return {
			name: parseSkillMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(bytes), `/skillflux-remote-uniqueness/${path}`).name,
			path,
			skillFileHash: createHash("sha256").update(bytes).digest("hex")
		};
	} catch {
		return;
	}
}
/**
* Prove that the pinned repository contains exactly one usable Skill with the
* requested name and return the immutable blobs in that Skill directory.
*/
async function verifyUniqueRemoteSkill(candidate, signal) {
	signal?.throwIfAborted();
	assertPinnedCandidate(candidate);
	const treeUrl = repositoryUrl(candidate, `/git/trees/${encodeURIComponent(candidate.ref)}?recursive=1`);
	const response = await fetch(treeUrl, {
		headers: githubHeaders$1(),
		...signal === void 0 ? {} : { signal }
	});
	if (!response.ok) throw new Error(`GitHub Skill uniqueness check failed: HTTP ${response.status}`);
	const payload = await response.json();
	if (payload.truncated !== false || !Array.isArray(payload.tree) || payload.tree.length > MAX_REPOSITORY_TREE_ITEMS || !payload.tree.every(isTreeItem)) throw new Error("cannot prove remote Skill uniqueness from a truncated or invalid GitHub tree");
	const allPaths = payload.tree.map((item) => item.path);
	if (new Set(allPaths).size !== allPaths.length) throw new Error("cannot prove remote Skill uniqueness from a GitHub tree with duplicate paths");
	const files = payload.tree.filter((item) => item.type === "blob").filter((item) => item.path === "SKILL.md" || item.path.endsWith("/SKILL.md"));
	if (files.length > MAX_REPOSITORY_SKILL_FILES) throw new Error(`cannot prove remote Skill uniqueness across more than ${MAX_REPOSITORY_SKILL_FILES} SKILL.md files`);
	const indexed = [];
	for (let offset = 0; offset < files.length; offset += FETCH_CONCURRENCY) {
		const batch = await Promise.all(files.slice(offset, offset + FETCH_CONCURRENCY).map(async (file) => await fetchSkill(candidate, file.path, file.sha, signal)));
		signal?.throwIfAborted();
		indexed.push(...batch.filter((skill) => skill !== void 0));
	}
	const matches = indexed.filter((skill) => skill.name === candidate.skillId);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? `remote repository does not contain Skill "${candidate.skillId}" at the pinned commit` : `remote repository contains ${matches.length} usable Skills named "${candidate.skillId}"; refusing ambiguous install`);
	const match = matches[0];
	if (candidate.path !== void 0 && match.path !== candidate.path) throw new Error(`unique remote Skill path "${match.path}" does not match discovered path "${candidate.path}"`);
	if (candidate.skillFileHash !== void 0 && match.skillFileHash !== candidate.skillFileHash) throw new Error("unique remote SKILL.md does not match the GitHub search preview");
	const separator = match.path.lastIndexOf("/");
	const directory = separator === -1 ? "" : match.path.slice(0, separator + 1);
	const selectedFiles = [];
	for (const file of payload.tree) {
		if (file.type !== "blob" || !file.path.startsWith(directory)) continue;
		if (directory.length > 0 && file.path.length === directory.length) continue;
		const selectedPath = directory.length === 0 ? file.path : file.path.slice(directory.length);
		if (file.mode === "120000") throw new Error(`remote Skill directory contains unsupported symbolic link "${selectedPath}"`);
		selectedFiles.push({
			path: selectedPath,
			sha: file.sha,
			size: file.size
		});
	}
	if (!selectedFiles.some((file) => file.path === "SKILL.md" && file.sha === files.find((file) => file.path === match.path)?.sha)) throw new Error("unique remote SKILL.md is not a regular file in its Skill directory");
	return {
		path: match.path,
		skillFileHash: match.skillFileHash,
		files: selectedFiles
	};
}
function assertMaterializeTarget(root, target) {
	const pathFromRoot = relative(resolve(root), resolve(target));
	if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new Error(`refusing to materialize a remote Skill outside its destination: ${target}`);
}
/** Download only the files already bound to the verified tree and blob SHAs. */
async function materializeVerifiedRemoteSkill(candidate, verified, destination, limits, signal) {
	signal?.throwIfAborted();
	assertPinnedCandidate(candidate);
	const files = verified.files;
	if (files === void 0 || files.length === 0 || files.length > limits.maxFiles) throw new Error(`remote Skill exceeds the ${limits.maxFiles}-file installation limit`);
	let declaredBytes = 0;
	for (const file of files) {
		const segments = file.path.split("/");
		if (file.path.length === 0 || file.path.length > MAX_REPOSITORY_PATH_LENGTH || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0") || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /[<>:"|?*]/u.test(segment) || [...segment].some((character) => character.charCodeAt(0) < 32) || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) || !/^[0-9a-f]{40}$/u.test(file.sha) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("verified remote Skill contains invalid file metadata");
		declaredBytes += file.size;
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.maxBytes) throw new Error(`remote Skill exceeds the ${limits.maxBytes}-byte installation limit`);
	}
	if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("verified remote Skill contains duplicate file paths");
	await mkdir(destination, { recursive: true });
	for (let offset = 0; offset < files.length; offset += FETCH_CONCURRENCY) {
		const batch = files.slice(offset, offset + FETCH_CONCURRENCY);
		const downloaded = await Promise.all(batch.map(async (file) => ({
			file,
			bytes: await fetchBlob(candidate, file.path, file.sha, Math.min(file.size, limits.maxBytes), signal)
		})));
		signal?.throwIfAborted();
		await Promise.all(downloaded.map(async ({ file, bytes }) => {
			if (bytes.length !== file.size) throw new Error(`remote Skill file size changed for "${file.path}"`);
			const target = join(destination, ...file.path.split("/"));
			assertMaterializeTarget(destination, target);
			await mkdir(resolve(target, ".."), { recursive: true });
			await writeFile(target, bytes, {
				flag: "wx",
				mode: 384
			});
		}));
		signal?.throwIfAborted();
	}
}
//#endregion
//#region src/cache.ts
const execFileAsync = promisify(execFile);
const MANIFEST_NAME = ".skillflux.json";
const CACHE_ID$1 = /^[0-9a-f]{24}$/u;
const PROCESS_INSTANCE_KEY = Symbol.for("dsh-skillflux.process-instance-id");
const PROCESS_LIVE_LEASES_KEY = Symbol.for("dsh-skillflux.process-live-leases");
const processScope = globalThis;
const existingProcessInstanceId = processScope[PROCESS_INSTANCE_KEY];
const PROCESS_INSTANCE_ID = typeof existingProcessInstanceId === "string" ? existingProcessInstanceId : randomUUID();
processScope[PROCESS_INSTANCE_KEY] = PROCESS_INSTANCE_ID;
const existingLiveLeases = processScope[PROCESS_LIVE_LEASES_KEY];
const PROCESS_LIVE_LEASE_IDS = existingLiveLeases instanceof Set ? existingLiveLeases : /* @__PURE__ */ new Set();
processScope[PROCESS_LIVE_LEASES_KEY] = PROCESS_LIVE_LEASE_IDS;
const ACTIVE_LEASE_HEARTBEAT_MS = 3e4;
const ACTIVE_LEASE_STALE_MS = 864e5;
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
	return item.version === 1 && typeof item.cacheId === "string" && CACHE_ID$1.test(item.cacheId) && typeof item.source === "string" && typeof item.ref === "string" && /^[0-9a-f]{40}$/u.test(item.ref) && typeof item.skillId === "string" && typeof item.name === "string" && typeof item.description === "string" && (item.installs === void 0 || typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0) && (item.qualityScore === void 0 || typeof item.qualityScore === "number" && Number.isSafeInteger(item.qualityScore) && item.qualityScore >= 0 && item.qualityScore <= 100) && (item.trustLevel === void 0 || item.trustLevel === "unverified" || item.trustLevel === "community" || item.trustLevel === "corroborated" || item.trustLevel === "trusted") && (item.stars === void 0 || typeof item.stars === "number" && Number.isSafeInteger(item.stars) && item.stars >= 0) && (item.pushedAt === void 0 || typeof item.pushedAt === "string") && (item.discoverySources === void 0 || Array.isArray(item.discoverySources) && item.discoverySources.every((source) => source === "skills.sh" || source === "github")) && (item.sourcePath === void 0 || typeof item.sourcePath === "string" && item.sourcePath.length > 0) && (item.sourceSkillFileHash === void 0 || typeof item.sourceSkillFileHash === "string" && /^[0-9a-f]{64}$/u.test(item.sourceSkillFileHash)) && item.sourcePath === void 0 === (item.sourceSkillFileHash === void 0) && typeof item.installedAt === "string" && Number.isFinite(Date.parse(item.installedAt)) && typeof item.fileCount === "number" && Number.isSafeInteger(item.fileCount) && item.fileCount >= 1 && typeof item.totalBytes === "number" && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= 0 && typeof item.contentHash === "string" && /^[0-9a-f]{64}$/u.test(item.contentHash) && (item.whenToUse === void 0 || typeof item.whenToUse === "string");
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
async function withAbort(operation, signal) {
	signal.throwIfAborted();
	return await new Promise((resolve, reject) => {
		const aborted = () => {
			reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};
		signal.addEventListener("abort", aborted, { once: true });
		operation.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", aborted);
		}).catch(() => void 0);
	});
}
var SkillCache = class {
	options;
	root;
	entriesRoot;
	stagingRoot;
	leasesRoot;
	constructor(options) {
		this.options = options;
		this.root = resolve(options.root);
		this.entriesRoot = join(this.root, "entries");
		this.stagingRoot = join(this.root, ".staging");
		this.leasesRoot = join(this.root, ".leases");
	}
	async list() {
		await mkdir(this.entriesRoot, { recursive: true });
		const names = await readdir(this.entriesRoot);
		return (await Promise.all(names.filter((name) => CACHE_ID$1.test(name)).map((name) => this.read(name)))).filter((entry) => entry !== void 0).sort((left, right) => right.manifest.installedAt.localeCompare(left.manifest.installedAt, "en"));
	}
	async get(id) {
		if (!CACHE_ID$1.test(id)) return void 0;
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
		const deadline = AbortSignal.timeout(this.options.installTimeoutMs);
		const operationSignal = signal === void 0 ? deadline : AbortSignal.any([signal, deadline]);
		operationSignal.throwIfAborted();
		const id = cacheId(candidate.source, candidate.ref, candidate.skillId);
		const existing = await this.get(id);
		operationSignal.throwIfAborted();
		if (existing !== void 0) return existing;
		const staging = join(this.stagingRoot, randomUUID());
		const workspace = join(staging, "workspace");
		const downloaded = join(workspace, ".agents", "skills", candidate.skillId);
		const destination = join(this.entriesRoot, id);
		assertWithin(this.root, staging);
		assertWithin(this.root, destination);
		await mkdir(workspace, { recursive: true });
		try {
			const verifiedSource = await withAbort((this.options.verifyCandidate ?? verifyUniqueRemoteSkill)(candidate, operationSignal), operationSignal);
			operationSignal.throwIfAborted();
			if (this.options.runInstaller === void 0 && verifiedSource.files !== void 0) await materializeVerifiedRemoteSkill(candidate, verifiedSource, downloaded, {
				maxFiles: this.options.maxFiles,
				maxBytes: this.options.maxBytes
			}, operationSignal);
			else {
				const runInstaller = this.options.runInstaller;
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
					if (runInstaller === void 0) await execFileAsync(process.execPath, args, {
						cwd: workspace,
						timeout: this.options.installTimeoutMs,
						maxBuffer: 2097152,
						signal: operationSignal,
						env
					});
					else await withAbort(runInstaller({
						executable: process.execPath,
						args,
						cwd: workspace,
						timeoutMs: this.options.installTimeoutMs,
						signal: operationSignal,
						env
					}), operationSignal);
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
			}
			await access(downloaded);
			operationSignal.throwIfAborted();
			{
				const downloadedSkill = await readFile(join(downloaded, "SKILL.md"));
				operationSignal.throwIfAborted();
				if (createHash("sha256").update(downloadedSkill).digest("hex") !== verifiedSource.skillFileHash) throw new Error("downloaded SKILL.md does not match the unique pinned GitHub source");
			}
			const inspected = await inspectSkillDirectory(downloaded, {
				maxFiles: this.options.maxFiles,
				maxBytes: this.options.maxBytes
			}, operationSignal);
			operationSignal.throwIfAborted();
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
				trustLevel: candidate.trustLevel,
				stars: candidate.stars,
				...candidate.pushedAt === void 0 ? {} : { pushedAt: candidate.pushedAt },
				discoverySources: candidate.discoverySources,
				sourcePath: verifiedSource.path,
				sourceSkillFileHash: verifiedSource.skillFileHash,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				fileCount: inspected.fileCount,
				totalBytes: inspected.totalBytes,
				contentHash: inspected.contentHash
			};
			operationSignal.throwIfAborted();
			await writeFile(join(downloaded, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
			operationSignal.throwIfAborted();
			await mkdir(this.entriesRoot, { recursive: true });
			await this.options.beforeInstallCommit?.();
			operationSignal.throwIfAborted();
			try {
				await rename(downloaded, destination);
				operationSignal.throwIfAborted();
			} catch (error) {
				const raced = await this.get(id);
				operationSignal.throwIfAborted();
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
	async clean(selector, active = /* @__PURE__ */ new Set(), signal) {
		signal?.throwIfAborted();
		const protectedIds = /* @__PURE__ */ new Set([...active, ...await this.activeLeaseIds(signal)]);
		signal?.throwIfAborted();
		if (selector === "all") {
			await mkdir(this.entriesRoot, { recursive: true });
			const directories = (await readdir(this.entriesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && CACHE_ID$1.test(entry.name)).map((entry) => ({
				id: entry.name,
				directory: join(this.entriesRoot, entry.name)
			}));
			const removed = [];
			const skipped = [];
			for (const entry of directories) {
				signal?.throwIfAborted();
				if (protectedIds.has(entry.id)) {
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
			signal?.throwIfAborted();
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
			signal?.throwIfAborted();
			if (protectedIds.has(entry.manifest.cacheId)) {
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
		signal?.throwIfAborted();
		return {
			removed,
			skipped
		};
	}
	async stats() {
		await mkdir(this.entriesRoot, { recursive: true });
		const directories = (await readdir(this.entriesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && CACHE_ID$1.test(entry.name));
		const entries = await this.list();
		return {
			entries: entries.length,
			totalBytes: entries.reduce((total, entry) => Math.min(Number.MAX_SAFE_INTEGER, total + entry.manifest.totalBytes), 0),
			invalidEntries: Math.max(0, directories.length - entries.length)
		};
	}
	async prune(policy, evidence = [], active = /* @__PURE__ */ new Set(), now = Date.now(), signal) {
		signal?.throwIfAborted();
		const protectedIds = /* @__PURE__ */ new Set([...active, ...await this.activeLeaseIds(signal)]);
		signal?.throwIfAborted();
		const plan = planCachePrune(await this.list(), evidence, policy, protectedIds, now);
		for (const decision of plan.decisions) {
			signal?.throwIfAborted();
			const directory = join(this.entriesRoot, decision.cacheId);
			assertWithin(this.entriesRoot, directory);
			await rm(directory, {
				recursive: true,
				force: true
			});
		}
		signal?.throwIfAborted();
		return plan;
	}
	async createActiveLease(cacheId) {
		if (!CACHE_ID$1.test(cacheId)) throw new Error(`invalid cache lease id "${cacheId}"`);
		const directory = join(this.leasesRoot, cacheId);
		const leaseId = randomUUID();
		const file = join(directory, `${process.pid}-${leaseId}.json`);
		assertWithin(this.root, directory);
		assertWithin(this.root, file);
		await mkdir(directory, { recursive: true });
		await writeFile(file, `${JSON.stringify({
			version: 1,
			pid: process.pid,
			instanceId: PROCESS_INSTANCE_ID,
			leaseId,
			createdAt: Date.now()
		})}\n`, {
			encoding: "utf8",
			flag: "wx"
		});
		PROCESS_LIVE_LEASE_IDS.add(leaseId);
		const heartbeat = setInterval(() => {
			const now = /* @__PURE__ */ new Date();
			utimes(file, now, now).catch(() => void 0);
		}, ACTIVE_LEASE_HEARTBEAT_MS);
		heartbeat.unref();
		let heartbeatStopped = false;
		let released = false;
		return async () => {
			if (released) return;
			if (!heartbeatStopped) {
				clearInterval(heartbeat);
				heartbeatStopped = true;
			}
			PROCESS_LIVE_LEASE_IDS.delete(leaseId);
			if (this.options.removeLeaseMarker !== void 0) await this.options.removeLeaseMarker(file, directory);
			else await removeLeaseMarker(file, directory);
			released = true;
		};
	}
	async activeLeaseIds(signal) {
		signal?.throwIfAborted();
		await mkdir(this.leasesRoot, { recursive: true });
		const active = /* @__PURE__ */ new Set();
		const directories = await readdir(this.leasesRoot, { withFileTypes: true });
		for (const directory of directories) {
			signal?.throwIfAborted();
			if (!directory.isDirectory() || !CACHE_ID$1.test(directory.name)) continue;
			const leaseDirectory = join(this.leasesRoot, directory.name);
			assertWithin(this.root, leaseDirectory);
			await this.options.beforeLeaseDirectoryRead?.(leaseDirectory);
			let names;
			try {
				names = await readdir(leaseDirectory);
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			for (const name of names) {
				signal?.throwIfAborted();
				const file = join(leaseDirectory, name);
				assertWithin(this.root, file);
				let pid;
				let instanceId;
				let leaseId;
				let heartbeatAt;
				try {
					const [raw, metadata] = await Promise.all([readFile(file, "utf8"), stat(file)]);
					const parsed = JSON.parse(raw);
					if (typeof parsed === "object" && parsed !== null) {
						const candidate = parsed.pid;
						if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) pid = candidate;
						const candidateInstance = parsed.instanceId;
						if (typeof candidateInstance === "string" && candidateInstance.length > 0) instanceId = candidateInstance;
						const candidateLease = parsed.leaseId;
						if (typeof candidateLease === "string" && candidateLease.length > 0) leaseId = candidateLease;
					}
					heartbeatAt = metadata.mtimeMs;
				} catch {}
				const heartbeatFresh = heartbeatAt !== void 0 && Math.max(0, Date.now() - heartbeatAt) <= ACTIVE_LEASE_STALE_MS;
				const currentInstance = pid === process.pid && instanceId === PROCESS_INSTANCE_ID && leaseId !== void 0 && PROCESS_LIVE_LEASE_IDS.has(leaseId);
				const activeExternalProcess = pid !== void 0 && pid !== process.pid && heartbeatFresh && processIsAlive(pid);
				if (currentInstance || activeExternalProcess) {
					active.add(directory.name);
					continue;
				}
				signal?.throwIfAborted();
				await rm(file, { force: true });
			}
			await removeEmptyLeaseDirectory(leaseDirectory);
		}
		signal?.throwIfAborted();
		return active;
	}
	async read(id) {
		if (!CACHE_ID$1.test(id)) return void 0;
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
function processIsAlive(pid) {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}
async function removeLeaseMarker(file, directory) {
	await rm(file, { force: true });
	await removeEmptyLeaseDirectory(directory);
}
async function removeEmptyLeaseDirectory(directory) {
	try {
		await rmdir(directory);
	} catch (error) {
		const code = error.code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
	}
}
//#endregion
//#region src/catalog.ts
function sessionLength(agent) {
	const session = agent.session;
	if (typeof session.seq === "number") return session.seq;
	return session.events?.length ?? 0;
}
function sessionEventAt(agent, index) {
	const session = agent.session;
	if (typeof session.eventAt === "function") return session.eventAt(index);
	return session.events?.[index];
}
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
		if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.source !== "string" || typeof item.ref !== "string" || typeof item.installs !== "number" || !Array.isArray(item.discoverySources) || !item.discoverySources.every((value) => typeof value === "string") || typeof item.qualityScore !== "number" || typeof item.relevanceScore !== "number" || typeof item.stars !== "number" || typeof item.recentlyActive !== "boolean" || typeof item.trustedSource !== "boolean" || typeof item.trustLevel !== "string" || !Array.isArray(item.qualitySignals) || !item.qualitySignals.every((value) => typeof value === "string") || !Array.isArray(item.qualityWarnings) || !item.qualityWarnings.every((value) => typeof value === "string")) return void 0;
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
			trustedSource: item.trustedSource,
			trustLevel: item.trustLevel,
			qualitySignals: item.qualitySignals,
			qualityWarnings: item.qualityWarnings
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
		entry.trustedSource,
		entry.trustLevel,
		entry.qualitySignals,
		entry.qualityWarnings
	])).join("\n")).digest("hex");
}
function history(agent) {
	const visible = new Set(agent.session.surface.nodes);
	let published = false;
	for (let index = sessionLength(agent) - 1; index >= 0; index -= 1) {
		const event = sessionEventAt(agent, index);
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
	for (let index = sessionLength(agent) - 1; index >= 0; index -= 1) {
		const event = sessionEventAt(agent, index);
		if (event === void 0 || event.type !== "user/message" || event.data.source.kind !== "skillflux-candidates") continue;
		published = true;
		const entries = readRemoteEntries(event.data.source);
		if (entries === void 0) continue;
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
		trustedSource: candidate.trustedSource,
		trustLevel: candidate.trustLevel,
		qualitySignals: candidate.qualitySignals,
		qualityWarnings: candidate.qualityWarnings
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
		trustedSource: candidate.trustedSource,
		trustLevel: candidate.trustLevel,
		qualitySignals: candidate.qualitySignals,
		qualityWarnings: candidate.qualityWarnings
	}));
	const lines = entries.map((entry) => `- \`${entry.id}\` — \`${entry.name}\` from ${entry.source} @ ${entry.ref.slice(0, 12)} (quality ${entry.qualityScore}, relevance ${entry.relevanceScore}, ${entry.installs} installs, ${entry.stars} stars, ${entry.recentlyActive ? "active in freshness window" : "older activity"}, ${entry.trustLevel} evidence via ${entry.discoverySources.join("+")}${entry.qualityWarnings.length === 0 ? "" : `, warnings ${entry.qualityWarnings.join("+")}`})`);
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
//#region src/discovery.ts
function governedCacheCandidates(entries, config) {
	return cacheCandidates(entries).flatMap((candidate) => {
		if (candidate.origin !== "cache") return [];
		if (candidateGovernanceReason(candidate, config) !== void 0) return [];
		const trustLevel = currentCandidateTrust(candidate, config);
		return [{
			...candidate,
			trustLevel
		}];
	});
}
function automaticDiscoveryQuery(task) {
	return [...tokenize(task)].filter((token) => token.length >= 2 && token.length <= 32 && !/^(?:sk|key|token)-?[a-z0-9]{12,}$/u.test(token)).slice(0, 12).join(" ");
}
function dedupeByName(candidates) {
	const unique = /* @__PURE__ */ new Map();
	for (const candidate of candidates) if (!unique.has(candidate.name)) unique.set(candidate.name, candidate);
	return [...unique.values()];
}
function dedupeById(candidates) {
	return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}
/**
* Observe the registry catalog with one retry. The filesystem provider's
* watcher can report transiently incomplete observations while roots settle;
* a second observation usually completes. Persistent incompleteness still
* returns the partial observation so callers can fail open with usable
* candidates instead of stalling search and routing.
*/
async function retriedSnapshot(skills, options, warn) {
	let snapshot = await skills.snapshot(options);
	if (snapshot.complete) return snapshot;
	options.signal?.throwIfAborted();
	await new Promise((resolve) => {
		setTimeout(resolve, 60);
	});
	options.signal?.throwIfAborted();
	snapshot = await skills.snapshot(options);
	if (!snapshot.complete) warn?.("SkillFlux catalog snapshot is incomplete; continuing with partial candidates");
	return snapshot;
}
var DiscoveryCoordinator = class {
	host;
	constructor(host) {
		this.host = host;
	}
	async discover(agent, query, options = {}) {
		const snapshot = await retriedSnapshot(this.host.runtimeCtx.skills, skillLookup(agent, options.signal), (message) => {
			this.host.runtimeCtx.logger.warn(message);
		});
		options.signal?.throwIfAborted();
		const installed = snapshot.skills.filter(isModelInvocable);
		const cached = await this.host.cache.list();
		options.signal?.throwIfAborted();
		const local = dedupeByName([...registryCandidates(installed), ...governedCacheCandidates(cached, this.host.config)]);
		const selected = await this.selectLocalCandidates(query, local, this.host.config.remoteSearchLimit, this.host.config.remoteSearchLimit, options.signal);
		options.signal?.throwIfAborted();
		if (options.remote !== true || this.host.config.remoteDiscovery === "off") return selected;
		const remote = await this.host.remote.search(query, options.signal);
		options.signal?.throwIfAborted();
		return dedupeById([...selected, ...remote]).slice(0, this.host.config.remoteSearchLimit * 2);
	}
	async selectLocalCandidates(query, candidates, limit, semanticTrigger, signal) {
		if (limit <= 0 || candidates.length === 0) return [];
		let boosts;
		if (this.host.config.adaptiveRouting && this.host.usage !== void 0) try {
			boosts = await this.host.usage.boosts(candidates, {
				maxBoost: this.host.config.adaptiveMaxBoost,
				minUses: this.host.config.adaptiveMinUses,
				halfLifeDays: this.host.config.adaptiveHalfLifeDays
			});
			signal?.throwIfAborted();
		} catch (error) {
			signal?.throwIfAborted();
			this.host.runtimeCtx.logger.warn(`SkillFlux adaptive routing failed open: ${errorMessage$4(error)}`);
		}
		const lexical = selectCandidates(query, candidates, {
			limit,
			minScore: this.host.config.minRouteScore,
			routes: this.host.config.routes,
			...boosts === void 0 ? {} : { boosts }
		});
		if (this.host.embedding === void 0 || lexical.length >= semanticTrigger || lexical.length >= limit) return lexical;
		const selectedNames = new Set(lexical.map((candidate) => candidate.name));
		const remaining = candidates.filter((candidate) => !selectedNames.has(candidate.name));
		try {
			const semantic = await this.host.embedding.rank(query, remaining, limit - lexical.length, signal);
			signal?.throwIfAborted();
			return [...lexical, ...semantic];
		} catch (error) {
			signal?.throwIfAborted();
			this.host.runtimeCtx.logger.warn(`SkillFlux embedding routing failed open: ${errorMessage$4(error)}`);
			return lexical;
		}
	}
};
function errorMessage$4(error) {
	return error instanceof Error ? error.message : String(error);
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
//#region src/provider.ts
const SKILLFLUX_PROVIDER = "skillflux";
function locatorFor(agent, candidates) {
	return Object.freeze({
		brand: "skillflux",
		agent,
		candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })))
	});
}
function readLocator(candidate) {
	const locator = candidate.locator;
	if (typeof locator !== "object" || locator === null || locator.brand !== "skillflux") return void 0;
	if (typeof locator.agent !== "object" || locator.agent === null) return void 0;
	const chain = locator.candidates;
	if (!Array.isArray(chain) || chain.length === 0) return void 0;
	const winner = chain[0];
	if (typeof winner !== "object" || winner === null || winner.name !== candidate.name) return void 0;
	return locator;
}
var SkillFluxProvider = class {
	control;
	host;
	name = SKILLFLUX_PROVIDER;
	constructor(control, host) {
		this.control = control;
		this.host = host;
	}
	async list(options) {
		options.signal?.throwIfAborted();
		this.control.signal.throwIfAborted();
		const scope = options.scope;
		const catalog = this.host.catalog(scope);
		const groups = /* @__PURE__ */ new Map();
		for (const candidate of catalog.candidates) {
			const chain = groups.get(candidate.name) ?? [];
			chain.push(candidate);
			groups.set(candidate.name, chain);
		}
		const candidates = [...groups.values()].map((chain, rank) => this.summary(scope, chain, rank));
		return catalog.complete ? candidates : {
			candidates,
			complete: false
		};
	}
	async get(candidate, options) {
		options.signal?.throwIfAborted();
		this.control.signal.throwIfAborted();
		if (candidate.provider !== this.name) throw new Error(`SkillFlux provider received a candidate owned by "${candidate.provider}"`);
		const locator = readLocator(candidate);
		if (locator === void 0) throw new Error("SkillFlux candidate locator is unknown or expired");
		return await this.host.load(locator.agent, locator.candidates, options.signal);
	}
	summary(scope, chain, rank) {
		const candidate = chain[0];
		return {
			name: candidate.name,
			description: candidate.description,
			invocation: {
				modelInvocable: true,
				userInvocable: false
			},
			source: SKILLFLUX_PROVIDER,
			provider: this.name,
			rank: 300 + rank,
			locator: locatorFor(scope, chain)
		};
	}
};
var SkillFluxProviderManager = class {
	host;
	warn;
	control;
	registered = false;
	constructor(host, warn) {
		this.host = host;
		this.warn = warn;
	}
	/**
	* Register one host-level provider. Agent isolation lives in list(), where
	* the registry passes the viewing agent as the runtime scope; a scoped
	* agent context does not expose `ctx.skills` for per-agent registration.
	* Fails open on registration errors.
	*/
	install(skills) {
		if (this.registered) return true;
		try {
			skills.registerProvider((control) => {
				this.control = control;
				return new SkillFluxProvider(control, this.host);
			});
			this.registered = true;
			return true;
		} catch (error) {
			this.warn(`SkillFlux provider registration failed open: ${errorMessage$3(error)}`);
			return false;
		}
	}
	invalidate() {
		this.control?.invalidate();
	}
	/**
	* Resolve and lazily load one published name directly. The registry merges
	* runtime entries above provider candidates, so a same-name runtime entry
	* would otherwise shadow the provider's own get() for the filtered tool.
	*/
	async load(agent, name, signal) {
		const chain = this.host.catalog(agent).candidates.filter((candidate) => candidate.name === name);
		if (chain.length === 0) return void 0;
		return await this.host.load(agent, chain, signal);
	}
};
function errorMessage$3(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/remote-cache.ts
const CACHE_VERSION = 2;
const MAX_CACHE_FILE_BYTES = 4194304;
const MAX_CACHE_ENTRIES = 1e3;
const CACHE_KEY = /^[0-9a-f]{64}$/u;
const CANDIDATE_ID = /^[0-9a-f]{24}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;
const GITHUB_SOURCE$1 = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SKILL_NAME$1 = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TRUST_LEVELS = /* @__PURE__ */ new Set([
	"unverified",
	"community",
	"corroborated",
	"trusted"
]);
const QUALITY_SIGNALS = /* @__PURE__ */ new Set([
	"trusted-owner",
	"cross-source",
	"content-pinned",
	"recent-activity",
	"declared-license",
	"organization-owned",
	"market-adoption",
	"repository-adoption"
]);
const QUALITY_WARNINGS = /* @__PURE__ */ new Set([
	"single-source",
	"content-not-previewed",
	"activity-unknown",
	"stale-activity",
	"license-missing",
	"low-adoption"
]);
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
function validStringSet(value, allowed, maximum) {
	return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && allowed.has(item)) && new Set(value).size === value.length;
}
function validBreakdown(value, total) {
	if (typeof value !== "object" || value === null || !count$1(total, 100)) return false;
	const item = value;
	const keys = [
		"relevance",
		"adoption",
		"repository",
		"freshness",
		"trust",
		"provenance"
	];
	if (!keys.every((key) => count$1(item[key], 100)) || item.total !== total) return false;
	const sum = keys.reduce((result, key) => result + item[key], 0);
	return Math.min(100, sum) === total;
}
function validCandidate(value) {
	if (typeof value !== "object" || value === null) return false;
	const item = value;
	if (!(typeof item.id === "string" && CANDIDATE_ID.test(item.id) && item.origin === "remote" && boundedString$1(item.name, 128) && SKILL_NAME$1.test(item.name) && boundedString$1(item.description, 4096) && typeof item.source === "string" && GITHUB_SOURCE$1.test(item.source) && typeof item.ref === "string" && COMMIT_SHA.test(item.ref) && count$1(item.score) && item.selection === "remote-quality" && optionalCount(item.baseScore) && optionalCount(item.adaptiveBoost) && typeof item.skillId === "string" && SKILL_NAME$1.test(item.skillId) && count$1(item.installs) && validProviders(item.discoverySources) && count$1(item.qualityScore, 100) && count$1(item.relevanceScore) && count$1(item.stars) && count$1(item.forks) && (item.pushedAt === void 0 || boundedString$1(item.pushedAt, 64) && Number.isFinite(Date.parse(item.pushedAt))) && (item.license === void 0 || boundedString$1(item.license, 128)) && typeof item.recentlyActive === "boolean" && typeof item.trustedSource === "boolean" && typeof item.trustLevel === "string" && TRUST_LEVELS.has(item.trustLevel) && validBreakdown(item.qualityBreakdown, item.qualityScore) && validStringSet(item.qualitySignals, QUALITY_SIGNALS, QUALITY_SIGNALS.size) && validStringSet(item.qualityWarnings, QUALITY_WARNINGS, QUALITY_WARNINGS.size) && validSkillPath(item.path) && (item.skillFileHash === void 0 || typeof item.skillFileHash === "string" && CONTENT_HASH.test(item.skillFileHash)))) return false;
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
		discoverySources: [...candidate.discoverySources],
		qualityBreakdown: { ...candidate.qualityBreakdown },
		qualitySignals: [...candidate.qualitySignals],
		qualityWarnings: [...candidate.qualityWarnings]
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
const RANKING_VERSION = 2;
function boundedQuery(query) {
	return query.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().slice(0, 128);
}
function discoveryCacheKey(query, options, githubSearchEnabled) {
	return createHash("sha256").update(JSON.stringify({
		rankingVersion: RANKING_VERSION,
		query,
		searchLimit: options.searchLimit,
		providers: options.providers,
		minQualityScore: options.minQualityScore,
		minStars: options.minStars,
		recentActivityDays: options.recentActivityDays,
		trustPolicy: options.trustPolicy,
		trustedOwners: options.trustedOwners,
		blockedOwners: options.blockedOwners,
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
function activityAgeDays(pushedAt, now) {
	if (pushedAt === void 0) return void 0;
	const pushed = Date.parse(pushedAt);
	if (!Number.isFinite(pushed)) return void 0;
	return Math.max(0, (now - pushed) / 864e5);
}
function remoteQualityScore(input) {
	return remoteQualityEvidence(input).breakdown.total;
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
function githubContentUrl(source, ref, path) {
	return `https://api.github.com/repos/${source.split("/").map(encodeURIComponent).join("/")}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
}
async function githubSeed(hit, snapshot, signal, token) {
	const response = await fetch(githubContentUrl(hit.repository.full_name, snapshot.ref, hit.path), {
		headers: {
			...githubHeaders(token),
			accept: "application/vnd.github.raw+json"
		},
		signal
	});
	if (!response.ok) throw new Error(`GitHub Skill fetch failed for ${hit.repository.full_name}/${hit.path}: HTTP ${response.status}`);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_SKILL_BYTES) throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`);
	const bytes = Buffer$1.from(await response.arrayBuffer());
	if (bytes.length > MAX_REMOTE_SKILL_BYTES) throw new Error(`remote SKILL.md exceeds ${MAX_REMOTE_SKILL_BYTES} bytes`);
	const definition = parseSkillMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "/skillflux-remote-preview");
	if (definition.description.length > 4096) throw new Error("remote Skill description exceeds 4096 characters");
	return {
		source: hit.repository.full_name,
		skillId: definition.name,
		name: definition.name,
		description: definition.description,
		installs: 0,
		discoverySources: ["github"],
		path: hit.path,
		skillFileHash: createHash("sha256").update(bytes).digest("hex")
	};
}
function mergeSeeds(seeds, refBySource) {
	const merged = /* @__PURE__ */ new Map();
	const ambiguous = /* @__PURE__ */ new Set();
	for (const seed of seeds) {
		const ref = refBySource.get(seed.source)?.ref;
		if (ref === void 0) continue;
		const key = `${seed.source}\0${ref}\0${seed.skillId}`;
		if (ambiguous.has(key)) continue;
		const prior = merged.get(key);
		if (prior === void 0) {
			merged.set(key, seed);
			continue;
		}
		if (prior.path !== void 0 && seed.path !== void 0 && prior.path !== seed.path) {
			merged.delete(key);
			ambiguous.add(key);
			continue;
		}
		const discoverySources = [.../* @__PURE__ */ new Set([...prior.discoverySources, ...seed.discoverySources])];
		const preferred = prior.path === void 0 && seed.path !== void 0 ? seed : prior.path !== void 0 && seed.path !== void 0 && seed.path.localeCompare(prior.path, "en") < 0 ? seed : prior;
		merged.set(key, {
			...preferred,
			description: seed.discoverySources.includes("github") ? seed.description : prior.description,
			installs: Math.max(prior.installs, seed.installs),
			discoverySources,
			...preferred.path === void 0 ? {} : { path: preferred.path },
			...preferred.skillFileHash === void 0 ? {} : { skillFileHash: preferred.skillFileHash }
		});
	}
	return [...merged.values()];
}
var RemoteDiscoveryClient = class {
	options;
	githubToken;
	now;
	cache;
	health = /* @__PURE__ */ new Map();
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
			trustPolicy: options.trustPolicy ?? "community",
			trustedOwners: options.trustedOwners ?? [],
			blockedOwners: options.blockedOwners ?? [],
			healthFailureThreshold: options.healthFailureThreshold ?? 3,
			healthCooldownMs: options.healthCooldownMs ?? 6e4
		};
		this.githubToken = configuredGithubToken(options.githubToken);
		this.now = options.now ?? Date.now;
		this.cache = options.cache;
	}
	get githubSearchEnabled() {
		return this.options.providers.includes("github") && this.githubToken !== void 0;
	}
	async search(query, signal) {
		return (await this.searchWithStatus(query, signal)).candidates;
	}
	async searchWithStatus(query, signal) {
		const normalized = boundedQuery(query);
		if (normalized.length === 0) return {
			candidates: [],
			complete: true
		};
		signal?.throwIfAborted();
		const key = discoveryCacheKey(normalized, this.options, this.githubSearchEnabled);
		const cached = await this.cache?.get(key);
		signal?.throwIfAborted();
		if (cached?.state === "fresh") return {
			candidates: [...cached.candidates],
			complete: true
		};
		const operationSignal = timeoutSignal(signal, this.options.timeoutMs);
		try {
			const live = await this.searchLive(normalized, operationSignal);
			if (cached?.state === "stale" && live.degraded && live.candidates.length === 0) {
				this.cache?.recordStaleHit();
				return {
					candidates: [...cached.candidates],
					complete: false
				};
			}
			if (!live.degraded || cached === void 0 && live.candidates.length > 0) await this.cache?.put(key, live.candidates);
			return {
				candidates: live.candidates,
				complete: !live.degraded
			};
		} catch (error) {
			signal?.throwIfAborted();
			if (cached?.state === "stale") {
				this.cache?.recordStaleHit();
				return {
					candidates: [...cached.candidates],
					complete: false
				};
			}
			throw error;
		}
	}
	remoteSourceHealth() {
		const nowMs = this.now();
		return this.options.providers.map((provider) => {
			const entry = this.health.get(provider);
			return {
				provider,
				consecutiveFailures: entry?.failures ?? 0,
				...entry !== void 0 && entry.cooldownUntil > nowMs ? { cooldownUntil: entry.cooldownUntil } : {}
			};
		});
	}
	providerAvailable(provider) {
		const entry = this.health.get(provider);
		return entry === void 0 || entry.cooldownUntil <= this.now();
	}
	recordHealth(provider, success) {
		if (success) {
			this.health.delete(provider);
			return;
		}
		const current = this.health.get(provider);
		const failures = (current?.failures ?? 0) + 1;
		const cooldownUntil = failures >= this.options.healthFailureThreshold ? this.now() + this.options.healthCooldownMs : current?.cooldownUntil ?? 0;
		this.health.set(provider, {
			failures,
			cooldownUntil
		});
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
		if (this.options.providers.includes("skills.sh") && this.providerAvailable("skills.sh")) providerTasks.push(searchSkillsSh(normalized, poolLimit, operationSignal).then((value) => ({
			provider: "skills.sh",
			status: "ok",
			value
		}), (error) => ({
			provider: "skills.sh",
			status: "error",
			error
		})));
		if (this.options.providers.includes("github") && this.githubToken !== void 0 && this.providerAvailable("github")) providerTasks.push(searchGithub(normalized, poolLimit, operationSignal, this.githubToken).then((value) => ({
			provider: "github",
			status: "ok",
			value
		}), (error) => ({
			provider: "github",
			status: "error",
			error
		})));
		if (providerTasks.length === 0) {
			if (this.options.providers.length === 1 && this.options.providers[0] === "github") throw new Error("GitHub Skill search requires GITHUB_TOKEN or GH_TOKEN");
			return {
				candidates: [],
				degraded: true
			};
		}
		const outcomes = await Promise.all(providerTasks);
		operationSignal.throwIfAborted();
		for (const outcome of outcomes) this.recordHealth(outcome.provider, outcome.status === "ok");
		const fulfilled = outcomes.flatMap((outcome) => outcome.status === "ok" ? [{
			provider: outcome.provider,
			value: outcome.value
		}] : []);
		let degraded = outcomes.some((outcome) => outcome.status === "error");
		if (fulfilled.length === 0) {
			const failed = outcomes.find((outcome) => outcome.status === "error");
			throw failed?.error instanceof Error ? failed.error : /* @__PURE__ */ new Error("remote Skill discovery failed");
		}
		const blockedOwners = new Set(this.options.blockedOwners.map((owner) => owner.toLocaleLowerCase("en-US")));
		const blocked = (source) => {
			const owner = source.split("/")[0]?.toLocaleLowerCase("en-US") ?? "";
			return blockedOwners.has(owner);
		};
		const skillsSeeds = fulfilled.flatMap((result) => result.provider === "skills.sh" ? result.value : []).filter((seed) => !blocked(seed.source));
		const githubHits = fulfilled.flatMap((result) => result.provider === "github" ? result.value : []).filter((hit) => !blocked(hit.repository.full_name));
		const sources = [.../* @__PURE__ */ new Set([...skillsSeeds.map((seed) => seed.source), ...githubHits.map((hit) => hit.repository.full_name)])];
		const snapshots = await resolveRepositories(sources, operationSignal, this.githubToken);
		if (snapshots.size < sources.length) degraded = true;
		operationSignal.throwIfAborted();
		const githubSeeds = await Promise.allSettled(githubHits.map(async (hit) => {
			const snapshot = snapshots.get(hit.repository.full_name);
			if (snapshot === void 0) throw new Error("repository metadata unavailable");
			return await githubSeed(hit, snapshot, operationSignal, this.githubToken);
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
			const evidence = remoteQualityEvidence({
				relevanceScore,
				installs: seed.installs,
				stars: snapshot.stars,
				forks: snapshot.forks,
				...snapshot.pushedAt === void 0 ? {} : { pushedAt: snapshot.pushedAt },
				recentActivityDays: this.options.recentActivityDays,
				trustedSource,
				organizationOwned: snapshot.organizationOwned,
				hasLicense: snapshot.license !== void 0,
				discoverySourceCount: seed.discoverySources.length,
				contentPinned: seed.path !== void 0 && seed.skillFileHash !== void 0,
				now
			});
			const qualityScore = evidence.breakdown.total;
			if (qualityScore < this.options.minQualityScore) return [];
			if (!remoteTrustPolicyAllows(evidence.trustLevel, this.options.trustPolicy)) return [];
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
				trustLevel: evidence.trustLevel,
				qualityBreakdown: evidence.breakdown,
				qualitySignals: evidence.signals,
				qualityWarnings: evidence.warnings,
				...seed.path === void 0 ? {} : { path: seed.path },
				...seed.skillFileHash === void 0 ? {} : { skillFileHash: seed.skillFileHash }
			}];
		});
		candidates.sort(compareRemoteCandidates);
		return {
			candidates: deduplicateRemoteCandidates(candidates).slice(0, this.options.searchLimit),
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
const CACHE_ID = /^[0-9a-f]{24}$/u;
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
	return boundedString(item.candidateId, 512) && boundedString(item.name, 128) && (item.origin === "registry" || item.origin === "cache" || item.origin === "remote") && boundedString(item.source, 2048) && (item.cacheId === void 0 || typeof item.cacheId === "string" && CACHE_ID.test(item.cacheId)) && count(item.mounts) && count(item.uses) && timestamp(item.lastMountedAt) && timestamp(item.lastUsedAt);
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
		return [...(await this.readLatest()).values()].sort(usageOrder).slice(0, Math.max(0, Math.min(limit, this.options.maxEntries))).map((record) => ({ ...record }));
	}
	async cacheEvidence() {
		await this.writeQueue;
		return [...(await this.readLatest()).values()].map((record) => ({
			source: record.source,
			name: record.name,
			...record.cacheId === void 0 ? {} : { cacheId: record.cacheId },
			mounts: record.mounts,
			uses: record.uses,
			...record.lastMountedAt === void 0 ? {} : { lastMountedAt: record.lastMountedAt },
			...record.lastUsedAt === void 0 ? {} : { lastUsedAt: record.lastUsedAt }
		}));
	}
	async boosts(candidates, options) {
		if (!Number.isSafeInteger(options.maxBoost) || options.maxBoost < 0 || options.maxBoost > 20) throw new Error("adaptive maxBoost must be an integer from 0 to 20");
		if (!Number.isSafeInteger(options.minUses) || options.minUses < 1 || options.minUses > 1e3) throw new Error("adaptive minUses must be an integer from 1 to 1000");
		if (!Number.isFinite(options.halfLifeDays) || options.halfLifeDays < .1 || options.halfLifeDays > 3650) throw new Error("adaptive halfLifeDays must be from 0.1 to 3650");
		await this.writeQueue;
		const records = await this.readLatest();
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
		const task = this.writeQueue.then(async () => await this.withFileLock(async (signal) => {
			const records = await this.readDocument();
			signal.throwIfAborted();
			await update(records);
			signal.throwIfAborted();
			this.trim(records);
			await this.save(records, signal);
		}));
		this.writeQueue = task.catch(() => void 0);
		await task;
	}
	async readLatest() {
		return await this.withFileLock(async (signal) => {
			const records = await this.readDocument();
			signal.throwIfAborted();
			this.trim(records);
			return records;
		});
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
	async save(records, signal) {
		const directory = dirname(this.options.file);
		const temporary = join(directory, `.${basename(this.options.file)}.${randomUUID()}.tmp`);
		const serialized = this.serializeWithinLimit(records);
		signal?.throwIfAborted();
		await mkdir(directory, { recursive: true });
		try {
			signal?.throwIfAborted();
			await writeFile(temporary, serialized, {
				encoding: "utf8",
				flag: "wx"
			});
			signal?.throwIfAborted();
			await rename(temporary, this.options.file);
			signal?.throwIfAborted();
		} catch (error) {
			await unlink(temporary).catch(() => void 0);
			throw error;
		}
	}
	async withFileLock(operation) {
		await mkdir(dirname(this.options.file), { recursive: true });
		const controller = new AbortController();
		let compromised;
		const release = await lock(this.options.file, {
			realpath: false,
			stale: 1e4,
			update: 5e3,
			retries: {
				retries: 50,
				factor: 1,
				minTimeout: 100,
				maxTimeout: 100,
				randomize: true
			},
			onCompromised: (error) => {
				compromised = error;
				controller.abort(error);
			}
		});
		let result;
		let operationError;
		try {
			controller.signal.throwIfAborted();
			result = await operation(controller.signal);
			controller.signal.throwIfAborted();
		} catch (error) {
			operationError = error;
		}
		let releaseError;
		try {
			await release();
		} catch (error) {
			releaseError = error;
		}
		if (compromised !== void 0) throw new Error(`SkillFlux usage lock was compromised: ${errorMessage$1(compromised)}`, { cause: compromised });
		if (operationError !== void 0) throw operationError;
		if (releaseError !== void 0) throw releaseError;
		return result;
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
const OLLAMA_EMBEDDING_ENDPOINT = "http://127.0.0.1:11434/api/embed";
const OPENAI_EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULTS = {
	maxActiveSkills: 3,
	minRouteScore: 8,
	approvalPolicy: "always",
	remoteDiscovery: "automatic",
	remoteProviders: ["skills.sh", "github"],
	remoteSearchLimit: 5,
	remoteAutoMountLimit: 3,
	remoteSearchTimeoutMs: 3e4,
	remoteMinQualityScore: 35,
	remoteMinStars: 0,
	remoteRecentActivityDays: 30,
	remoteTrustPolicy: "community",
	remoteTrustedOwners: [],
	remoteBlockedOwners: [],
	remoteCacheTtlMs: 3e5,
	remoteCacheStaleIfErrorMs: 864e5,
	remoteCacheMaxEntries: 100,
	remoteHealthFailureThreshold: 3,
	remoteHealthCooldownMs: 6e4,
	cacheAutoPrune: true,
	cacheMaxEntries: 100,
	cacheMaxTotalBytes: 536870912,
	cacheMaxIdleDays: 90,
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
function remoteOwners(name, values) {
	const owners = values.map((value) => value.trim()).filter((value) => value.length > 0);
	for (const owner of owners) if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) throw new Error(`dsh-skillflux: invalid GitHub owner "${owner}" in ${name}`);
	return [...new Set(owners.map((owner) => owner.toLocaleLowerCase("en-US")))].sort((left, right) => left.localeCompare(right, "en"));
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
		remoteAutoMountLimit: boundedInteger("remoteAutoMountLimit", config.remoteAutoMountLimit ?? DEFAULTS.remoteAutoMountLimit, 1, 5),
		remoteSearchTimeoutMs: boundedInteger("remoteSearchTimeoutMs", config.remoteSearchTimeoutMs ?? DEFAULTS.remoteSearchTimeoutMs, 100, 12e4),
		remoteMinQualityScore: boundedInteger("remoteMinQualityScore", config.remoteMinQualityScore ?? DEFAULTS.remoteMinQualityScore, 0, 100),
		remoteMinStars: boundedInteger("remoteMinStars", config.remoteMinStars ?? DEFAULTS.remoteMinStars, 0, 1e7),
		remoteRecentActivityDays: boundedInteger("remoteRecentActivityDays", config.remoteRecentActivityDays ?? DEFAULTS.remoteRecentActivityDays, 1, 3650),
		remoteTrustPolicy: config.remoteTrustPolicy ?? DEFAULTS.remoteTrustPolicy,
		remoteTrustedOwners: remoteOwners("remoteTrustedOwners", config.remoteTrustedOwners ?? DEFAULTS.remoteTrustedOwners),
		remoteBlockedOwners: remoteOwners("remoteBlockedOwners", config.remoteBlockedOwners ?? DEFAULTS.remoteBlockedOwners),
		remoteCacheTtlMs: boundedInteger("remoteCacheTtlMs", config.remoteCacheTtlMs ?? DEFAULTS.remoteCacheTtlMs, 0, 6048e5),
		remoteCacheStaleIfErrorMs: boundedInteger("remoteCacheStaleIfErrorMs", config.remoteCacheStaleIfErrorMs ?? DEFAULTS.remoteCacheStaleIfErrorMs, 0, 2592e6),
		remoteCacheMaxEntries: boundedInteger("remoteCacheMaxEntries", config.remoteCacheMaxEntries ?? DEFAULTS.remoteCacheMaxEntries, 1, 1e3),
		remoteHealthFailureThreshold: boundedInteger("remoteHealthFailureThreshold", config.remoteHealthFailureThreshold ?? DEFAULTS.remoteHealthFailureThreshold, 1, 100),
		remoteHealthCooldownMs: boundedInteger("remoteHealthCooldownMs", config.remoteHealthCooldownMs ?? DEFAULTS.remoteHealthCooldownMs, 0, 36e5),
		cacheAutoPrune: config.cacheAutoPrune ?? DEFAULTS.cacheAutoPrune,
		cacheMaxEntries: boundedInteger("cacheMaxEntries", config.cacheMaxEntries ?? DEFAULTS.cacheMaxEntries, 1, 1e4),
		cacheMaxTotalBytes: boundedInteger("cacheMaxTotalBytes", config.cacheMaxTotalBytes ?? DEFAULTS.cacheMaxTotalBytes, 1, Number.MAX_SAFE_INTEGER),
		cacheMaxIdleDays: boundedInteger("cacheMaxIdleDays", config.cacheMaxIdleDays ?? DEFAULTS.cacheMaxIdleDays, 0, 3650),
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
	const blockedOwners = new Set(resolved.remoteBlockedOwners);
	const conflictingOwner = resolved.remoteTrustedOwners.find((owner) => blockedOwners.has(owner));
	if (conflictingOwner !== void 0) throw new Error(`dsh-skillflux: GitHub owner "${conflictingOwner}" cannot be both trusted and blocked`);
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
		remoteAutoMountLimit: z.number().default(DEFAULTS.remoteAutoMountLimit),
		remoteSearchTimeoutMs: z.number().default(DEFAULTS.remoteSearchTimeoutMs),
		remoteMinQualityScore: z.number().default(DEFAULTS.remoteMinQualityScore),
		remoteMinStars: z.number().default(DEFAULTS.remoteMinStars),
		remoteRecentActivityDays: z.number().default(DEFAULTS.remoteRecentActivityDays),
		remoteTrustPolicy: z.union([
			"open",
			"community",
			"corroborated",
			"trusted"
		]).default(DEFAULTS.remoteTrustPolicy),
		remoteTrustedOwners: z.array(z.string()).default([]),
		remoteBlockedOwners: z.array(z.string()).default([]),
		remoteCacheTtlMs: z.number().default(DEFAULTS.remoteCacheTtlMs),
		remoteCacheStaleIfErrorMs: z.number().default(DEFAULTS.remoteCacheStaleIfErrorMs),
		remoteCacheMaxEntries: z.number().default(DEFAULTS.remoteCacheMaxEntries),
		remoteHealthFailureThreshold: z.number().default(DEFAULTS.remoteHealthFailureThreshold),
		remoteHealthCooldownMs: z.number().default(DEFAULTS.remoteHealthCooldownMs),
		cacheAutoPrune: z.boolean().default(DEFAULTS.cacheAutoPrune),
		cacheMaxEntries: z.number().default(DEFAULTS.cacheMaxEntries),
		cacheMaxTotalBytes: z.number().default(DEFAULTS.cacheMaxTotalBytes),
		cacheMaxIdleDays: z.number().default(DEFAULTS.cacheMaxIdleDays),
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
	cacheLeaseCount = 0;
	cacheMaintenancePending = false;
	cacheLeaseWaiters = /* @__PURE__ */ new Set();
	cacheIdleWaiters = /* @__PURE__ */ new Set();
	activeLeaseTasks = /* @__PURE__ */ new Set();
	pendingActiveLeaseCleanups = /* @__PURE__ */ new Set();
	cacheProcessLock = lock;
	cacheMaintenanceQueue = Promise.resolve();
	autoPruneTask;
	autoPruneRequested = false;
	turnStates;
	discovery;
	providers;
	trustedBySession = /* @__PURE__ */ new WeakMap();
	cachePruneSessions = /* @__PURE__ */ new WeakSet();
	constructor(ctx, config = {}) {
		super(ctx, "skillFlux");
		this.runtimeCtx = ctx;
		this.config = resolveConfig(config);
		this.turnStates = new TurnStateRegistry((message) => {
			ctx.logger.warn(message);
		});
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
			trustPolicy: this.config.remoteTrustPolicy,
			trustedOwners: this.config.remoteTrustedOwners,
			blockedOwners: this.config.remoteBlockedOwners,
			cache: discoveryCache,
			healthFailureThreshold: this.config.remoteHealthFailureThreshold,
			healthCooldownMs: this.config.remoteHealthCooldownMs
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
		this.discovery = new DiscoveryCoordinator(this.discoveryHost);
		this.providers = new SkillFluxProviderManager({
			catalog: (scope) => {
				const agent = scope;
				if (agent === void 0) return {
					candidates: [],
					complete: true
				};
				return this.turnStates.peek(agent)?.published ?? {
					candidates: [],
					complete: true
				};
			},
			load: (agent, candidates, signal) => this.loadProviderBody(agent, candidates, signal)
		}, (message) => {
			ctx.logger.warn(message);
		});
		this.providers.install(ctx.skills);
		const skillTool = this.createSkillTool();
		ctx.tools.register(skillTool);
		ctx.tools.register(this.createSearchTool());
		ctx.tools.register(this.createMountTool());
		registerApprovalGate(ctx, this.approvalHost);
		this.registerCommand(ctx);
		this.registerExplicitInvocation(ctx);
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject") return decision;
			signal.throwIfAborted();
			if (ctx.tools.get(skillTool.name, agent) !== skillTool) return decision;
			const state = this.state(agent);
			const active = [...state.active.values()].map((item) => item.definition).filter(isModelInvocable);
			const published = state.published.candidates.map((candidate) => ({
				name: candidate.name,
				description: candidate.description,
				invocation: {
					modelInvocable: true,
					userInvocable: false
				},
				source: SKILLFLUX_PROVIDER,
				provider: SKILLFLUX_PROVIDER
			}));
			const skills = [];
			const seenNames = /* @__PURE__ */ new Set();
			for (const skill of [...active, ...published]) {
				if (seenNames.has(skill.name)) continue;
				seenNames.add(skill.name);
				skills.push(skill);
				if (skills.length >= this.config.maxActiveSkills) break;
			}
			return {
				kind: "enter",
				messages: updateCatalog(agent, decision.messages, skills, this.config.catalogDescriptionMaxLength)
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
			if (event.type !== "turn/end") return;
			this.cleanupSession(session);
			this.scheduleSessionCachePrune(session);
		});
		ctx.on("session/disposed", (session) => {
			this.disposeSession(session);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			this.disposeAgent(agent);
		});
		ctx.effect(() => async () => {
			this.turnStates.cleanupAll();
			await Promise.all(this.usageTasks);
			await this.usage?.flush();
			while (this.activeLeaseTasks.size > 0) await Promise.all(this.activeLeaseTasks);
			await this.retryPendingActiveLeaseCleanups();
			await this.autoPruneTask;
		});
	}
	get discoveryHost() {
		return {
			runtimeCtx: this.runtimeCtx,
			cache: this.cache,
			remote: this.remote,
			config: this.config,
			embedding: this.embedding,
			usage: this.usage
		};
	}
	get activationHost() {
		return {
			config: this.config,
			cache: this.cache,
			runtimeCtx: this.runtimeCtx,
			usage: this.usage,
			trustedBySession: this.trustedBySession,
			cachePruneSessions: this.cachePruneSessions,
			trackUsage: (operation) => {
				this.trackUsage(operation);
			},
			acquireCacheLease: () => this.acquireCacheLease(),
			trackActiveLeaseCleanup: (operation) => this.trackActiveLeaseCleanup(operation),
			assertCapacity: (state, name) => {
				this.assertCapacity(state, name);
			},
			assertCatalogBudget: (state, skill) => {
				this.assertCatalogBudget(state, skill);
			},
			assertMountCurrent: (state, generation, name, mountEpoch) => {
				this.assertMountCurrent(state, generation, name, mountEpoch);
			},
			rememberRouting: (state, mounted) => {
				this.rememberRouting(state, mounted);
			},
			scheduleAutoPrune: () => {
				this.scheduleAutoPrune();
			}
		};
	}
	get approvalHost() {
		return {
			config: this.config,
			trustedBySession: this.trustedBySession,
			candidate: (agent, candidateId) => this.candidate(agent, candidateId),
			publishedRemote: (agent, name) => this.publishedRemote(agent, name)
		};
	}
	async discover(agent, query, options = {}) {
		return await this.discovery.discover(agent, query, options);
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
		const state = this.turnStates.peek(agent);
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
		return this.turnStates.mounted(agent);
	}
	catalogStats(agent) {
		const mounted = this.mounted(agent);
		const state = this.turnStates.peek(agent);
		const skills = [...mounted.map((item) => item.definition), ...state?.published.candidates.map((candidate) => ({
			name: candidate.name,
			description: candidate.description,
			invocation: {
				modelInvocable: true,
				userInvocable: false
			},
			source: "skillflux",
			provider: "skillflux"
		})) ?? []];
		return {
			mountedSkills: skills.length,
			estimatedTokens: estimateCatalogTokens(skills, this.config.catalogDescriptionMaxLength),
			...this.config.catalogTokenBudget === 0 ? {} : { budget: this.config.catalogTokenBudget }
		};
	}
	lastRouting(agent) {
		return this.turnStates.lastRouting(agent);
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
	async cacheStats() {
		return await this.cache.stats();
	}
	async discoveryCacheStats() {
		return await this.remote.discoveryCacheStats();
	}
	async clearDiscoveryCache() {
		return await this.remote.clearDiscoveryCache();
	}
	async cleanCache(selector) {
		return await this.runCacheMaintenance(async (signal) => await this.cache.clean(selector, this.activeCacheIds(), signal));
	}
	async pruneCache() {
		return await this.runCacheMaintenance(async (signal) => {
			signal.throwIfAborted();
			await Promise.all(this.usageTasks);
			signal.throwIfAborted();
			const evidence = await this.usage?.cacheEvidence() ?? [];
			signal.throwIfAborted();
			return await this.cache.prune({
				maxEntries: this.config.cacheMaxEntries,
				maxTotalBytes: this.config.cacheMaxTotalBytes,
				maxIdleMs: this.config.cacheMaxIdleDays * 24 * 60 * 6e4
			}, evidence, this.activeCacheIds(), Date.now(), signal);
		});
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
				const definition = await this.skillDefinition(agent, args.name, exec.signal);
				if (definition === void 0) throw new Error(`skill "${args.name}" is not mounted for this turn`);
				if (!isModelInvocable(definition)) throw new Error(`skill "${args.name}" is not model-invocable`);
				const active = this.turnStates.active(agent, args.name);
				if (active !== void 0) this.trackUsage(this.usage?.recordUse(usageIdentity(active)));
				return skillResult(definition);
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
									trustLevel: { type: "string" },
									qualityBreakdown: {
										type: "object",
										additionalProperties: false,
										properties: {
											relevance: {
												type: "integer",
												required: true
											},
											adoption: {
												type: "integer",
												required: true
											},
											repository: {
												type: "integer",
												required: true
											},
											freshness: {
												type: "integer",
												required: true
											},
											trust: {
												type: "integer",
												required: true
											},
											provenance: {
												type: "integer",
												required: true
											},
											total: {
												type: "integer",
												required: true
											}
										}
									},
									qualitySignals: {
										type: "array",
										items: { type: "string" }
									},
									qualityWarnings: {
										type: "array",
										items: { type: "string" }
									},
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
							trustLevel: candidate.trustLevel,
							qualityBreakdown: candidate.qualityBreakdown,
							qualitySignals: [...candidate.qualitySignals],
							qualityWarnings: [...candidate.qualityWarnings],
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
			input: { hint: "status | explain | usage | cache list | cache prune | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean" },
			handler: async (invocation) => await this.executeCommand(invocation)
		});
	}
	async executeCommand(invocation) {
		const parts = invocation.rawInput.trim().split(/\s+/u).filter(Boolean);
		if (parts.length === 1 && parts[0] === "status") {
			const mounted = this.mounted(invocation.agent);
			const stats = this.embeddingStats();
			const discoveryCache = await this.discoveryCacheStats();
			const installedCache = await this.cacheStats();
			const catalog = this.catalogStats(invocation.agent);
			const router = this.config.routerMode === "lexical" ? "Router: lexical." : `Router: hybrid (${this.config.embeddingProvider}, ${this.config.embeddingModel}); embedding requests ${stats?.requests ?? 0}, cache ${stats?.cacheEntries ?? 0}/${this.config.embeddingCacheSize}.`;
			const telemetry = `Usage tracking: ${this.config.usageTracking ? "on" : "off"}; adaptive routing: ${this.config.adaptiveRouting ? "on" : "off"}.`;
			const catalogBudget = catalog.budget === void 0 ? "off" : String(catalog.budget);
			const sourceHealth = this.remote.remoteSourceHealth();
			const discovery = `Remote discovery: ${this.config.remoteDiscovery}; providers ${this.config.remoteProviders.map((provider) => {
				if (provider === "github" && !this.remote.githubSearchEnabled) return "github (token unavailable)";
				const health = sourceHealth.find((item) => item.provider === provider);
				if (health?.cooldownUntil !== void 0) return `${provider} (degraded, ${health.consecutiveFailures} failures)`;
				if ((health?.consecutiveFailures ?? 0) > 0) return `${provider} (${health?.consecutiveFailures ?? 0} failures)`;
				return provider;
			}).join(", ")}; evidence policy ${this.config.remoteTrustPolicy}; quality >= ${this.config.remoteMinQualityScore}; stars >= ${this.config.remoteMinStars}; recent window ${this.config.remoteRecentActivityDays} days; ${this.config.remoteBlockedOwners.length} blocked owner(s).`;
			const discoveryCacheStatus = discoveryCache === void 0 ? "Remote discovery cache: unavailable." : `Remote discovery cache: ${discoveryCache.enabled ? "on" : "off"}; ${discoveryCache.entries}/${this.config.remoteCacheMaxEntries} entries; hits ${discoveryCache.hits}, misses ${discoveryCache.misses}, stale fallbacks ${discoveryCache.staleHits}.`;
			const idlePolicy = this.config.cacheMaxIdleDays === 0 ? "off" : `${this.config.cacheMaxIdleDays} days`;
			const invalidCacheStatus = installedCache.invalidEntries === 0 ? "" : `; invalid entries ${installedCache.invalidEntries} (use cache clean all)`;
			return {
				kind: "success",
				text: `${router}\n${telemetry}\n${discovery}\n${discoveryCacheStatus}\n${`Installed Skill cache: ${installedCache.entries}/${this.config.cacheMaxEntries} entries, ${installedCache.totalBytes}/${this.config.cacheMaxTotalBytes} bytes; auto prune ${this.config.cacheAutoPrune ? "on" : "off"}; idle limit ${idlePolicy}${invalidCacheStatus}.`}\nCatalog: ${catalog.mountedSkills} mounted, ~${catalog.estimatedTokens} estimated tokens; budget ${catalogBudget}.\n${mounted.length === 0 ? "SkillFlux: no skills are mounted for the current turn." : `SkillFlux mounted:\n${mounted.map((item) => `- ${item.name} (${item.origin}, ${item.source})`).join("\n")}`}`
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
		if (parts.length === 2 && parts[0] === "cache" && parts[1] === "prune") {
			const plan = await this.pruneCache();
			const reasons = /* @__PURE__ */ new Map();
			for (const decision of plan.decisions) reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1);
			const reasonText = [...reasons.entries()].map(([reason, count]) => `${reason}: ${count}`).join(", ");
			return {
				kind: "success",
				text: `SkillFlux cache prune removed ${plan.decisions.length} entr${plan.decisions.length === 1 ? "y" : "ies"}${reasonText.length === 0 ? "" : ` (${reasonText})`}; ${plan.afterEntries} entries and ${plan.afterBytes} bytes remain${plan.protected.length === 0 ? "." : `; protected active: ${plan.protected.join(", ")}.`}`
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
			text: "Usage: /skillflux status | explain | usage | cache list | cache prune | cache clean <cache-id|all> | discovery-cache status | discovery-cache clean"
		};
	}
	async routeTurn(agent, task, turn, explicit, signal) {
		const state = this.beginTurn(agent, turn);
		const generation = state.generation;
		const snapshot = await retriedSnapshot(this.runtimeCtx.skills, skillLookup(agent, signal), (message) => {
			this.runtimeCtx.logger.warn(message);
		});
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		const cached = await this.cache.list();
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		const localPool = [...registryCandidates(snapshot.skills.filter(isModelInvocable)), ...governedCacheCandidates(cached, this.config)].filter((candidate) => !explicit.has(candidate.name));
		const fallbacksByName = /* @__PURE__ */ new Map();
		for (const candidate of localPool) {
			const fallbacks = fallbacksByName.get(candidate.name) ?? [];
			fallbacks.push(candidate);
			fallbacksByName.set(candidate.name, fallbacks);
		}
		const local = dedupeByName(localPool);
		const selected = await this.discovery.selectLocalCandidates(task, local, Math.min(local.length, this.config.maxActiveSkills * 3), this.config.maxActiveSkills, signal);
		signal.throwIfAborted();
		this.assertStateCurrent(state, generation);
		state.lastRouting = selected.map((candidate) => routingTrace(candidate, turn));
		const published = [];
		for (const candidate of selected) {
			if (state.active.size + published.length >= this.config.maxActiveSkills) break;
			let accepted = false;
			let budgetSkipped = false;
			for (const fallback of fallbacksByName.get(candidate.name) ?? []) {
				const normalized = {
					...fallback,
					...candidate.selection === void 0 ? {} : { selection: candidate.selection },
					...candidate.baseScore === void 0 ? {} : { baseScore: candidate.baseScore },
					...candidate.adaptiveBoost === void 0 ? {} : { adaptiveBoost: candidate.adaptiveBoost },
					score: candidate.score
				};
				if (normalized.origin === "registry") try {
					await this.mountCandidate(state, normalized, signal, generation);
					accepted = true;
					break;
				} catch (error) {
					signal.throwIfAborted();
					if (error instanceof ExpiredAgentStateError) throw error;
					if (error instanceof CatalogBudgetExceededError) budgetSkipped = true;
					else this.runtimeCtx.logger.warn(`SkillFlux skipped candidate ${fallback.name} from ${fallback.source}: ${errorMessage(error)}`);
				}
				else {
					if (state.active.size + published.length >= this.config.maxActiveSkills) break;
					if (!this.catalogFitsBudget(state, normalized)) {
						budgetSkipped = true;
						continue;
					}
					published.push(normalized);
					accepted = true;
				}
			}
			if (!accepted && budgetSkipped) this.markRoutingOutcome(state, candidate.id, "budget-skipped");
		}
		if (this.config.remoteDiscovery !== "automatic") {
			state.published = {
				candidates: published,
				complete: true
			};
			this.providers.invalidate();
			return updateRemoteCandidates(agent, []);
		}
		if (state.active.size + published.length >= this.config.maxActiveSkills) {
			state.published = {
				candidates: published,
				complete: true
			};
			this.providers.invalidate();
			return updateRemoteCandidates(agent, []);
		}
		let remoteCandidates = [];
		let remoteComplete = false;
		try {
			const observation = await this.remote.searchWithStatus(automaticDiscoveryQuery(task), signal);
			signal.throwIfAborted();
			this.assertStateCurrent(state, generation);
			remoteCandidates = observation.candidates;
			remoteComplete = observation.complete;
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof ExpiredAgentStateError) throw error;
			this.runtimeCtx.logger.warn(`SkillFlux remote discovery skipped: ${errorMessage(error)}`);
			state.published = {
				candidates: published,
				complete: false
			};
			this.providers.invalidate();
			return updateRemoteCandidates(agent, []);
		}
		const remainingSlots = this.config.maxActiveSkills - state.active.size - published.length;
		const remote = [];
		for (const candidate of remoteCandidates) if (this.catalogFitsBudget(state, candidate)) remote.push(candidate);
		else state.lastRouting.push({
			...routingTrace(candidate, turn),
			outcome: "budget-skipped"
		});
		for (const candidate of remote) state.candidates.set(candidate.id, candidate);
		if (remote.length === 0) {
			state.published = {
				candidates: published,
				complete: remoteComplete
			};
			this.providers.invalidate();
			return updateRemoteCandidates(agent, []);
		}
		const publishable = remote.filter((candidate) => candidateGovernanceReason(candidate, this.config) === void 0).slice(0, Math.min(this.config.remoteAutoMountLimit, remainingSlots));
		state.published = {
			candidates: [...published, ...publishable],
			complete: remoteComplete
		};
		this.providers.invalidate();
		return updateRemoteCandidates(agent, remote.filter((candidate) => state.candidates.has(candidate.id)));
	}
	async mountCandidate(state, candidate, signal, expectedGeneration = state.generation, expectedMountEpoch = state.mountEpochs.get(candidate.name) ?? 0) {
		return await activateCandidate(this.activationHost, state, candidate, signal, expectedGeneration, expectedMountEpoch);
	}
	assertCapacity(state, name) {
		if (state.active.has(name)) return;
		if (state.active.size >= this.config.maxActiveSkills) throw new Error(`cannot mount skill "${name}": the ${this.config.maxActiveSkills}-skill turn limit is reached`);
	}
	assertCatalogBudget(state, skill) {
		if (this.catalogFitsBudget(state, skill)) return;
		const estimatedTokens = estimateCatalogTokens([...this.catalogSkills(state), skill], this.config.catalogDescriptionMaxLength);
		throw new CatalogBudgetExceededError(skill.name, estimatedTokens, this.config.catalogTokenBudget);
	}
	catalogFitsBudget(state, skill) {
		if (this.config.catalogTokenBudget === 0 || state.active.has(skill.name)) return true;
		return estimateCatalogTokens([...this.catalogSkills(state), skill], this.config.catalogDescriptionMaxLength) <= this.config.catalogTokenBudget;
	}
	catalogSkills(state) {
		return [...[...state.active.values()].map((item) => item.definition), ...state.published.candidates.map((candidate) => ({
			name: candidate.name,
			description: candidate.description
		}))];
	}
	assertStateCurrent(state, generation) {
		this.turnStates.assertStateCurrent(state, generation);
	}
	assertMountCurrent(state, generation, name, mountEpoch) {
		this.turnStates.assertMountCurrent(state, generation, name, mountEpoch);
	}
	beginTurn(agent, turn) {
		return this.turnStates.beginTurn(agent, turn);
	}
	state(agent) {
		return this.turnStates.state(agent);
	}
	cleanupState(state, forget) {
		this.turnStates.cleanupState(state, forget);
		this.providers.invalidate();
	}
	rememberRouting(state, mounted) {
		this.turnStates.rememberRouting(state, mounted);
	}
	markRoutingOutcome(state, candidateId, outcome) {
		this.turnStates.markRoutingOutcome(state, candidateId, outcome);
	}
	recordRoutingOutcome(state, candidate, outcome) {
		const trace = {
			...routingTrace(candidate, state.turn),
			outcome
		};
		const index = state.lastRouting.findIndex((item) => item.candidateId === candidate.id);
		if (index === -1) state.lastRouting.push(trace);
		else state.lastRouting[index] = trace;
	}
	candidate(agent, candidateId) {
		return this.turnStates.candidate(agent, candidateId);
	}
	publishedRemote(agent, name) {
		const candidate = this.turnStates.peek(agent)?.published.candidates.find((item) => item.name === name);
		if (candidate === void 0 || candidate.origin !== "remote") return void 0;
		return candidate;
	}
	async skillDefinition(agent, name, signal) {
		const mounted = this.turnStates.active(agent, name);
		if (mounted !== void 0) return mounted.definition;
		if (this.turnStates.peek(agent)?.published.candidates.find((item) => item.name === name) === void 0) return void 0;
		return await this.providers.load(agent, name, signal);
	}
	async loadProviderBody(agent, candidates, signal) {
		const state = this.turnStates.peek(agent);
		if (state === void 0) throw new Error("SkillFlux turn state is gone");
		const generation = state.generation;
		const deadline = AbortSignal.timeout(this.config.installTimeoutMs);
		const loadSignal = signal === void 0 ? deadline : AbortSignal.any([signal, deadline]);
		let lastError;
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			this.assertStateCurrent(state, generation);
			const mountEpoch = state.mountEpochs.get(candidate.name) ?? 0;
			this.assertMountCurrent(state, generation, candidate.name, mountEpoch);
			if (deadline.aborted) break;
			try {
				const definition = await this.loadOne(agent, candidate, loadSignal);
				this.assertStateCurrent(state, generation);
				this.assertMountCurrent(state, generation, candidate.name, mountEpoch);
				state.candidates.clear();
				this.recordRoutingOutcome(state, candidate, "loaded");
				return definition;
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof ExpiredAgentStateError) throw error;
				this.assertMountCurrent(state, generation, candidate.name, mountEpoch);
				if (deadline.aborted || error instanceof Error && error.name === "TimeoutError") {
					lastError = error;
					state.candidates.delete(candidate.id);
					this.recordRoutingOutcome(state, candidate, "mount-timeout");
					break;
				}
				const outcome = error instanceof CatalogBudgetExceededError ? "budget-skipped" : "mount-failed";
				this.recordRoutingOutcome(state, candidate, outcome);
				state.candidates.delete(candidate.id);
				this.runtimeCtx.logger.warn(`SkillFlux lazy load ${outcome} for ${candidate.name} from ${candidate.source}: ${errorMessage(error)}`);
				lastError = error;
			}
		}
		throw lastError ?? /* @__PURE__ */ new Error("SkillFlux lazy load expired before any candidate was attempted");
	}
	async loadOne(agent, candidate, signal) {
		if (candidate.origin === "registry") throw new Error(`registry skill "${candidate.name}" must be mounted eagerly`);
		const governanceReason = candidateGovernanceReason(candidate, this.config);
		if (governanceReason !== void 0) throw new Error(`SkillFlux load denied: ${governanceReason}`);
		const releaseLease = await this.acquireCacheLease();
		const cacheSignal = releaseLease.signal === void 0 ? signal : signal === void 0 ? releaseLease.signal : AbortSignal.any([signal, releaseLease.signal]);
		try {
			let entry;
			if (candidate.origin === "cache") {
				const cached = await this.cache.get(candidate.cacheId);
				cacheSignal?.throwIfAborted();
				if (cached === void 0) throw new Error(`cache entry "${candidate.cacheId}" no longer exists`);
				const currentCachedCandidate = cacheCandidates([cached])[0];
				if (currentCachedCandidate === void 0) throw new Error(`cache entry "${candidate.cacheId}" is invalid`);
				const currentGovernanceReason = candidateGovernanceReason(currentCachedCandidate, this.config);
				if (currentGovernanceReason !== void 0) throw new Error(`SkillFlux load denied: ${currentGovernanceReason}`);
				entry = cached;
			} else {
				entry = await this.cache.install(candidate, cacheSignal);
				cacheSignal?.throwIfAborted();
			}
			const definition = await this.cache.load(entry, cacheSignal);
			cacheSignal?.throwIfAborted();
			if (!isModelInvocable(definition)) throw new Error(`skill "${definition.name}" is not model-invocable`);
			if (candidate.origin === "remote") {
				this.cachePruneSessions.add(agent.session);
				this.scheduleAutoPrune();
				if (this.config.approvalPolicy === "session") {
					let trusted = this.trustedBySession.get(agent.session);
					if (trusted === void 0) {
						trusted = /* @__PURE__ */ new Set();
						this.trustedBySession.set(agent.session, trusted);
					}
					trusted.add(candidate.source);
				}
			}
			return definition;
		} finally {
			await releaseLease();
		}
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
	activeCacheIds() {
		return this.turnStates.activeCacheIds();
	}
	async acquireCacheLease() {
		while (this.cacheMaintenancePending) await new Promise((resolve) => {
			this.cacheLeaseWaiters.add(resolve);
		});
		this.cacheLeaseCount += 1;
		let releaseProcessLock;
		try {
			releaseProcessLock = await this.acquireCacheProcessLock();
		} catch (error) {
			this.releaseLocalCacheLease();
			throw error;
		}
		let releaseTask;
		const release = async () => {
			releaseTask ??= (async () => {
				try {
					await releaseProcessLock();
				} finally {
					this.releaseLocalCacheLease();
				}
			})();
			await releaseTask;
		};
		return Object.assign(release, { signal: releaseProcessLock.signal });
	}
	releaseLocalCacheLease() {
		this.cacheLeaseCount = Math.max(0, this.cacheLeaseCount - 1);
		if (this.cacheLeaseCount !== 0) return;
		for (const resolve of this.cacheIdleWaiters) resolve();
		this.cacheIdleWaiters.clear();
	}
	async acquireCacheProcessLock() {
		await mkdir(this.cache.root, { recursive: true });
		const stale = Math.max(1e4, this.config.installTimeoutMs * 2);
		const controller = new AbortController();
		let compromised;
		const releaseFileLock = await this.cacheProcessLock(this.cache.root, {
			realpath: false,
			stale,
			update: Math.max(1e3, Math.min(1e4, Math.floor(stale / 2))),
			retries: {
				retries: Math.ceil((this.config.installTimeoutMs + 3e4) / 250),
				factor: 1,
				minTimeout: 250,
				maxTimeout: 250,
				randomize: true
			},
			onCompromised: (error) => {
				compromised = error;
				controller.abort(error);
			}
		});
		let releaseTask;
		const release = async () => {
			releaseTask ??= (async () => {
				let releaseError;
				try {
					await releaseFileLock();
				} catch (error) {
					releaseError = error;
				}
				if (compromised !== void 0) throw new Error(`SkillFlux cache process lock was compromised: ${errorMessage(compromised)}`, { cause: compromised });
				if (releaseError !== void 0) throw releaseError;
			})();
			await releaseTask;
		};
		return Object.assign(release, { signal: controller.signal });
	}
	async runCacheMaintenance(operation) {
		const task = this.cacheMaintenanceQueue.then(async () => {
			this.cacheMaintenancePending = true;
			if (this.cacheLeaseCount > 0) await new Promise((resolve) => {
				this.cacheIdleWaiters.add(resolve);
			});
			await this.retryPendingActiveLeaseCleanups();
			let releaseProcessLock;
			try {
				releaseProcessLock = await this.acquireCacheProcessLock();
				releaseProcessLock.signal.throwIfAborted();
				const result = await operation(releaseProcessLock.signal);
				releaseProcessLock.signal.throwIfAborted();
				await releaseProcessLock();
				return result;
			} finally {
				try {
					if (releaseProcessLock !== void 0) await releaseProcessLock();
				} finally {
					this.cacheMaintenancePending = false;
					for (const resolve of this.cacheLeaseWaiters) resolve();
					this.cacheLeaseWaiters.clear();
				}
			}
		});
		this.cacheMaintenanceQueue = task.then(() => void 0, () => void 0);
		return await task;
	}
	trackActiveLeaseCleanup(operation) {
		this.pendingActiveLeaseCleanups.add(operation);
		let tracked;
		tracked = this.retryActiveLeaseCleanup(operation).then(() => {
			this.pendingActiveLeaseCleanups.delete(operation);
		}).catch((error) => {
			this.runtimeCtx.logger.warn(`SkillFlux active cache lease cleanup failed: ${errorMessage(error)}`);
		}).finally(() => {
			this.activeLeaseTasks.delete(tracked);
		});
		this.activeLeaseTasks.add(tracked);
		return tracked;
	}
	async retryPendingActiveLeaseCleanups() {
		while (this.activeLeaseTasks.size > 0) await Promise.all(this.activeLeaseTasks);
		for (const operation of this.pendingActiveLeaseCleanups) try {
			await this.retryActiveLeaseCleanup(operation);
			this.pendingActiveLeaseCleanups.delete(operation);
		} catch (error) {
			this.runtimeCtx.logger.warn(`SkillFlux pending active cache lease cleanup failed: ${errorMessage(error)}`);
		}
	}
	async retryActiveLeaseCleanup(operation) {
		let lastError;
		for (let attempt = 0; attempt < 3; attempt += 1) try {
			await operation();
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 2) await new Promise((resolve) => {
				setTimeout(resolve, 25 * (attempt + 1));
			});
		}
		throw lastError;
	}
	scheduleAutoPrune() {
		if (!this.config.cacheAutoPrune) return;
		this.autoPruneRequested = true;
		if (this.autoPruneTask !== void 0) return;
		const task = (async () => {
			while (this.autoPruneRequested) {
				this.autoPruneRequested = false;
				try {
					const plan = await this.pruneCache();
					if (plan.decisions.length > 0) this.runtimeCtx.logger.info(`SkillFlux cache governance removed ${plan.decisions.length} low-value entr${plan.decisions.length === 1 ? "y" : "ies"}.`);
				} catch (error) {
					this.runtimeCtx.logger.warn(`SkillFlux automatic cache pruning failed open: ${errorMessage(error)}`);
				}
			}
		})().finally(() => {
			if (this.autoPruneTask === task) this.autoPruneTask = void 0;
		});
		this.autoPruneTask = task;
	}
	cleanupSession(session) {
		this.turnStates.cleanupSession(session);
		this.providers.invalidate();
		this.scheduleSessionCachePrune(session);
	}
	disposeSession(session) {
		this.turnStates.disposeSession(session);
		this.trustedBySession.delete(session);
		this.scheduleSessionCachePrune(session);
	}
	disposeAgent(agent) {
		const session = this.turnStates.disposeAgent(agent);
		if (session !== void 0) this.scheduleSessionCachePrune(session);
	}
	scheduleSessionCachePrune(session) {
		if (!this.cachePruneSessions.has(session)) return;
		this.cachePruneSessions.delete(session);
		this.scheduleAutoPrune();
	}
};
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
function formatTimestamp(value) {
	return value === void 0 ? "never" : new Date(value).toISOString();
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { EmbeddingRouter, RemoteDiscoveryCache, RemoteDiscoveryClient, SkillCache, SkillFluxService, SkillFluxService as default, UsageStore, compareRemoteCandidates, compareRemoteTrust, deduplicateRemoteCandidates, estimateCatalogTokens, estimateTextTokens, inspectSkillDirectory, isLoopbackProxyFailure, name, normalizeText, parseSkillMarkdown, planCachePrune, remoteDiscoveryCacheState, remoteQualityEvidence, remoteQualityScore, remoteTrustPolicyAllows, routeScore, selectCandidates, tokenize, verifyUniqueRemoteSkill };

//# sourceMappingURL=index.js.map