# SkillFlux evaluation corpus

`routing-cases.json` is a hand-authored deterministic benchmark for lexical
and adaptive routing. `semantic-routing-cases.json` checks the embedding ranking
contract with versioned synthetic vectors. `catalog-budget-cases.json` checks
catalog footprint boundaries and stable greedy admission, while
`remote-quality-cases.json` checks that relevance stays primary while current
adoption, repository, trust, and 30-day activity signals rank otherwise
comparable remote candidates. `remote-cache-cases.json` checks fresh, stale,
expired, and disabled cache boundaries. None of the suites calls an LLM, the
network, or a remote Skill registry.

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

The remote-cache corpus contains 7 policy cases covering exact TTL boundaries,
stale-if-error boundaries, and disabled-cache behavior. Integration tests
separately verify persistence, eviction, provider-failure fallback, and explicit
cancellation.

Routing and quality cases contain stable IDs, task/candidate inputs, and expected
ordering. Cache policy cases contain age/window inputs and an expected state.
Optional routing fields override the selector limit, score threshold, rules,
adaptive boosts, or expected rule-forced candidates. Add a focused case whenever
router, remote-quality, catalog-budget, or cache-policy behavior changes.

This corpus measures deterministic router behavior. It doesn't measure the
quality of third-party Skill instructions or the final answer from an online
model. Those require a separate, credential-backed end-to-end run.

## 中文说明

`routing-cases.json` 是词法与自适应 Router 的人工确定性测评集；
`semantic-routing-cases.json` 使用版本化合成向量验证 embedding 排序契约；
`remote-quality-cases.json` 验证相关性优先、采用度、仓库信号、可信 owner
和 30 天活跃度的排序约束；`catalog-budget-cases.json` 验证目录预算边界；
`remote-cache-cases.json` 验证 fresh、stale、expired 和关闭缓存的边界。这些测评
均不访问 LLM、网络或远程 Skill Registry。确定性部分重点验证中英文匹配、
规则优先级、阈值拒绝、
Selector 返回数量上限、来源排序、同名去重和短名称边界。

运行 `corepack pnpm eval` 后，命令会输出完整顺序准确率、Top-1 准确率、负例
拒绝率和 Selector 容量限制合规率，并输出语义排序的完整顺序、Top-1 和负例
拒绝指标。任何期望结果不一致都会使本地命令和 CI 失败。合成向量不评价具体
embedding 模型、第三方 Skill 指令质量或在线模型最终回答；这些需要另行执行
真实端到端测试。
