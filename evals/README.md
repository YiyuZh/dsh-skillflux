# SkillFlux evaluation corpus

`routing-cases.json` is a hand-authored deterministic benchmark for lexical
routing. `semantic-routing-cases.json` checks the embedding ranking contract
with versioned synthetic vectors. Neither suite calls an LLM, the network, or a
remote Skill registry.

The corpus covers:

- English and Chinese task matching.
- Unicode and case normalization.
- Ordered `matchAll` and `matchAny` rules.
- Score thresholds and irrelevant-task rejection.
- The one-to-three Skill selector result limit.
- Registry, cache, remote, install-count, and stable-source tie-breakers.
- Same-name candidate deduplication and short-name word boundaries.

Run the evaluation from the repository root:

```bash
corepack pnpm eval
```

The runner reports exact-order accuracy, top-one accuracy, negative rejection,
and selector-limit compliance. It also verifies the candidates forced by matching
rules. Any expected-result mismatch fails the command and CI.

The lexical corpus contains 36 cases. Its checked baseline is 100.0% for exact
ordered matches, positive-case top-one accuracy, negative-task rejection, and
selector-limit compliance.

The semantic corpus contains 8 English and Chinese cases covering semantic
fallback, top-k order, stable ties, and irrelevant-task rejection. Its baseline
is 100.0% for exact order, positive top-one accuracy, and negative rejection.
The vectors are synthetic: this validates SkillFlux's provider-independent
cosine ranking and threshold behavior, not the quality of a particular model.

Each case contains a stable ID, category, user task, candidate-pool keys, and the
expected ordered result. Optional fields override the selector limit, score
threshold, routing rules, or expected rule-forced candidates. Add a focused case
whenever router behavior changes or a routing regression is fixed.

This corpus measures deterministic router behavior. It doesn't measure the
quality of third-party Skill instructions or the final answer from an online
model. Those require a separate, credential-backed end-to-end run.

## 中文说明

`routing-cases.json` 是词法 Router 的人工确定性测评集；
`semantic-routing-cases.json` 使用版本化合成向量验证 embedding 排序契约。两者
均不访问 LLM、网络或远程 Skill Registry。词法部分重点验证中英文匹配、规则优先级、阈值拒绝、
Selector 返回数量上限、来源排序、同名去重和短名称边界。

运行 `corepack pnpm eval` 后，命令会输出完整顺序准确率、Top-1 准确率、负例
拒绝率和 Selector 容量限制合规率，并输出语义排序的完整顺序、Top-1 和负例
拒绝指标。任何期望结果不一致都会使本地命令和 CI 失败。合成向量不评价具体
embedding 模型、第三方 Skill 指令质量或在线模型最终回答；这些需要另行执行
真实端到端测试。
