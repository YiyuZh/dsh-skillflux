# SkillFlux evaluation corpus

`routing-cases.json` is a hand-authored deterministic benchmark for lexical
and adaptive routing. `semantic-routing-cases.json` checks the embedding ranking
contract with versioned synthetic vectors. `catalog-budget-cases.json` checks
catalog footprint boundaries and stable greedy admission, while
`remote-quality-cases.json` checks that relevance stays primary while current
adoption, repository, trust, and 30-day activity signals rank otherwise
comparable remote candidates. `remote-governance-cases.json` checks explainable
evidence levels, low-adoption warnings, and the open/community/corroborated/trusted
policy boundaries. `remote-cache-cases.json` checks fresh, stale,
expired, and disabled cache boundaries. `cache-governance-cases.json` checks
installed-cache age, value, capacity, byte, and active-mount boundaries.
`mcp-source-cases.json` checks the MCP Skills extension entry contract: SKILL.md
URI structure, frontmatter identity, digest and size formats, complete resource
enumeration, directory containment, and the refusal of `"dynamic"` content.
None of the suites calls an LLM, the network, or a remote Skill registry.

The corpus covers:

- English and Chinese task matching.
- Unicode and case normalization.
- Ordered `matchAll` and `matchAny` rules.
- Score thresholds and irrelevant-task rejection.
- The one-to-three Skill selector result limit.
- Registry, cache, remote, install-count, and stable-source tie-breakers.
- Same-name candidate deduplication and short-name word boundaries.
- Bounded adaptive reordering, rule priority, and relevance-threshold safety.

Run the evaluation from the repository root:

```bash
corepack pnpm eval
```

The runner reports exact-order accuracy, top-one accuracy, negative rejection,
and selector-limit compliance. It also verifies the candidates forced by matching
rules. Any expected-result mismatch fails the command and CI.

The deterministic corpus contains 36 lexical cases and 4 adaptive safety cases.
Its checked baseline is 100.0% for exact
ordered matches, positive-case top-one accuracy, negative-task rejection, and
selector-limit compliance.

The semantic corpus contains 8 English and Chinese cases covering semantic
fallback, top-k order, stable ties, and irrelevant-task rejection. Its baseline
is 100.0% for exact order, positive top-one accuracy, and negative rejection.
The vectors are synthetic: this validates SkillFlux's provider-independent
cosine ranking and threshold behavior, not the quality of a particular model.

The catalog-budget corpus contains 7 cases covering disabled budgets, exact
boundaries, ordered admission, CJK text, and description truncation. Its token
counts use the documented portable estimate rather than a model tokenizer.

The remote-quality corpus contains 8 pairwise cases. It covers exact new Skills
against weak popular matches, recent versus stale repositories, trusted owners,
market and repository adoption, organization/license evidence, and the 100-point
cap. These fixtures validate the scoring contract; they do not certify any live
repository.

The remote-governance corpus contains 8 evidence cases. It distinguishes a
directly content-pinned low-star Skill from an unverified index result, requires
both content pinning and multi-provider discovery for corroboration, treats an
explicit owner allowlist separately, and verifies every policy boundary.

The remote-cache corpus contains 7 policy cases covering exact TTL boundaries,
stale-if-error boundaries, and disabled-cache behavior. Integration tests
separately verify persistence, eviction, provider-failure fallback, and explicit
cancellation.

The installed-cache governance corpus contains 7 policy cases covering healthy
no-op behavior, idle eviction, usage-aware retention, byte pressure, active
mount protection, deterministic recency ordering, and immutable-version usage
isolation.

Routing and quality cases contain stable IDs, task/candidate inputs, and expected
ordering. Discovery-cache policy cases contain age/window inputs and an expected
state; installed-cache cases contain bounded entries, usage evidence, active IDs,
and expected eviction decisions.
Optional routing fields override the selector limit, score threshold, rules,
adaptive boosts, or expected rule-forced candidates. Add a focused case whenever
router, remote-quality, remote-governance, catalog-budget, or cache-policy
behavior changes.

This corpus measures deterministic router behavior. It doesn't measure the
quality of third-party Skill instructions or the final answer from an online
model. Those require a separate, credential-backed end-to-end run.

`remote-fallback-cases.json` adds 8 runtime scenarios for the lazy
provider-native path: metadata-only publication, first-success termination,
source/installer fallback during the `skill` call, the default attempt cap,
single-attempt mode, exhaustion, incomplete discovery observations, and both
manual approval policies. Its integration runner uses real cache files, the
agent-scoped provider registration, the `skill` tool, and turn cleanup with
fixture discovery/installation. Extra regressions cover shared deadlines,
cancellation, stale turns, owner policy, and explicit unmounts.

The MCP source corpus contains 12 entry cases spanning minimal valid skills,
nested paths with supporting files, dynamic-content refusal, name/URI
mismatches, missing or duplicated SKILL.md entries, path traversal, malformed
digests, invalid sizes and names, and empty resource sets. It validates the
entry gate only; `mcp-cache.spec.ts` covers byte-level digest verification and
`mcp-service.spec.ts` covers the end-to-end registration, discovery, lazy load,
fail-open, and governance boundaries.

## 中文说明

`remote-fallback-cases.json` 新增 8 个惰性发布场景，验证元数据发布、`skill` 调用
时的失败回退、次数上限、审批模式、成功停止、失败提示清理与不完整观测；集成测试
使用真实缓存目录、Agent 级 Provider 注册、Skill 工具及回合清理。额外回归用例覆盖
共享超时、取消、过期回合、owner 策略与显式卸载。

`provider-eval.spec.ts` 覆盖 Provider 原生惰性运行时的端到端语义：延迟到 `skill`
调用才下载、单次激活内只校验一次、并发 Agent 的目录隔离、`always` 审批 fail-closed、
会话级信任、同名回退链恢复损坏候选、调用取消传播，以及回合结束释放 Provider 目录。

`routing-cases.json` 是词法与自适应 Router 的人工确定性测评集；
`semantic-routing-cases.json` 使用版本化合成向量验证 embedding 排序契约；
`remote-quality-cases.json` 验证相关性优先、采用度、仓库信号、可信 owner
和 30 天活跃度的排序约束；`remote-governance-cases.json` 验证可解释证据等级、
低采用度告警及四级策略边界；`catalog-budget-cases.json` 验证目录预算边界；
`remote-cache-cases.json` 验证 fresh、stale、expired 和关闭缓存的边界，
`cache-governance-cases.json` 验证已安装缓存的闲置、价值、容量、总字节数和活动
挂载保护边界；`mcp-source-cases.json` 验证 MCP Skills 扩展的条目契约（SKILL.md
URI 结构、frontmatter 一致性、digest/size 格式、资源完整性、目录包含关系以及
对 `"dynamic"` 内容的拒绝）。这些测评均不访问 LLM、网络或远程 Skill Registry。确定性部分
重点验证中英文匹配、规则优先级、阈值拒绝、
Selector 返回数量上限、来源排序、同名去重和短名称边界。

运行 `corepack pnpm eval` 后，命令会输出完整顺序准确率、Top-1 准确率、负例
拒绝率和 Selector 容量限制合规率，并输出语义排序的完整顺序、Top-1 和负例
拒绝指标。任何期望结果不一致都会使本地命令和 CI 失败。合成向量不评价具体
embedding 模型、第三方 Skill 指令质量或在线模型最终回答；这些需要另行执行
真实端到端测试。
