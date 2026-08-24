# dsh-skillflux

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的动态 Skill
Runtime 管理器。

SkillFlux 不把完整 Skill 池永久暴露给模型。它会针对当前任务选择少量相关
Skill，只在当前回合挂载，并在回合结束后释放挂载。

> **当前状态：** 适配 DeepSeek Harness `0.1.1-rc.2` 的 v0.2。Harness
> 仍处于开发者预览阶段，本项目暂时跟随当前 RC API。

[English](README.md)

## 为什么需要 SkillFlux

Skill 越装越多，不应导致每次请求都携带越来越大的目录。目录过大会增加上下文
占用，也会让模型更难稳定选择合适的 Skill。

SkillFlux 位于 Agent 和 Skill 池之间。自动目录最多包含 `maxActiveSkills` 个
候选（默认 3 个），官方 DSH Skill Registry 仍是能力来源的唯一事实标准。
显式 `/skill-name` 调用继续单独生效。

## 快速开始

你需要 Node.js `22.20.0` 或更高版本，以及使用 `0.1.1-rc.2` 包版本的
DeepSeek Harness profile。

1. 将 SkillFlux 安装到正在使用的 profile：

   ```bash
   dsh plugin --profile web add github:YiyuZh/dsh-skillflux
   ```

   如果使用其他 profile，将 `web` 替换为对应名称，例如 `headless`。

2. 重启该 Harness profile。

3. 在 DSH 会话中验证运行状态：

   ```text
   /skillflux status
   ```

如需可复现部署，请固定提交：

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux#<commit-sha>
```

仓库已经提交构建后的 `lib/`，因此从 GitHub 安装时不会运行 `prepare`
脚本。Bundle patch 会禁用官方 `tool-skill` 消费层，并以唯一的
`skillflux` Loader ID 挂载本插件。官方 `skill` Registry 和
`skill-filesystem` Provider 保持启用。

## 工作方式

```text
用户任务
  -> 有序规则 + 确定性词法 Router
  -> 可选的有界使用历史排序
  -> 可选的 embedding 语义补位
  -> 本地 Registry + 持久缓存 + skills.sh
  -> 按配置上限选择并挂载 Skill（默认 3 个）
  -> Agent 调用已挂载的 Skill
  -> turn/end 自动卸载
  -> 下载文件保留到用户主动清理
```

每个挂载只属于接收任务的 Agent。卸载会阻止它继续出现在后续目录，但不会删除
缓存文件，也无法删除已经写入 session history 的文本。

## 功能

- 先按配置规则路由，再用确定性的英文单词和中文二元词评分。
- 可选根据成功加载记录，为已经通过词法相关性阈值的候选提供少量、随时间衰减
  的排序加分。
- 可选使用本地 Ollama 或 OpenAI-compatible embedding 服务，为尚未填满的目录
  位置补充语义相近 Skill。
- 使用 `maxActiveSkills` 限制模型可见目录。
- 从 DSH Registry、SkillFlux 缓存和
  [skills.sh](https://skills.sh/) 发现候选。
- 将远程候选固定到不可变的 GitHub commit SHA。
- 通过当前 Agent 的 `ctx.skills` scope 注册缓存 Skill。
- 每次加载前使用 SHA-256 manifest 校验缓存内容。
- 支持每次远程挂载审批、仓库会话内首次审批和自动审批三种策略。
- 提供加载、搜索和挂载 Skill 的模型工具。
- 提供查看状态、路由解释、使用统计和清理缓存的 `/skillflux` 用户命令。

## 路由规则

SkillFlux 按以下顺序处理任务：

1. 保留用户显式调用，例如 `/pdf-reader`，并将该名称排除在自动路由之外。
2. 按 Skill 名组织可供模型调用的 Registry 和缓存候选。Registry 条目优先代表
   该名称，同名缓存条目继续作为 fallback 保留。
3. 按配置顺序应用匹配的 `routes`。
4. 对剩余的名称代表候选进行确定性词法评分，并拒绝低于 `minRouteScore` 的
   候选。
5. 启用 `adaptiveRouting` 后，仅对已经通过 `minRouteScore` 的候选增加有界、随
   时间衰减的使用历史分。规则始终优先，历史不会让无关候选越过相关性阈值。
6. 在 `hybrid` 模式下，仅当规则和词法结果未填满目录时才使用 embedding；语义
   结果不会替换前面已经命中的规则或词法结果。
7. 依次挂载选中名称，直到达到 `maxActiveSkills`。如果首选候选加载失败，则按
   候选池顺序尝试同名 fallback。

词法评分如下：

| 命中方式 | 分数 |
| --- | ---: |
| 完整 Skill 名或空格分隔形式 | +100 |
| 每个名称词 | +20 |
| 每个 `whenToUse` 词 | +8 |
| 每个 description 词 | +3 |

同分时，本地 Registry 优先于缓存，缓存优先于远程候选。缓存同分时先比较安装
量，再按来源和名称进行稳定排序。

语义补位使用余弦相似度，拒绝低于 `minEmbeddingSimilarity` 的结果，并将分数
换算为 0-100 的整数。它始终位于有序规则和词法阶段之后。

## 配置

SkillFlux 支持以下插件配置：

```yaml
maxActiveSkills: 3
minRouteScore: 8
approvalPolicy: always       # always | session | automatic
remoteDiscovery: automatic   # automatic | on-demand | off
remoteSearchLimit: 5
remoteSearchTimeoutMs: 8000
catalogDescriptionMaxLength: 160
maxSkillFiles: 1000
maxSkillBytes: 10485760
installTimeoutMs: 300000
routerMode: lexical                # lexical | hybrid
embeddingProvider: ollama          # ollama | openai-compatible
embeddingEndpoint: http://127.0.0.1:11434/api/embed
embeddingModel: embeddinggemma
embeddingApiKeyEnv: SKILLFLUX_EMBEDDING_API_KEY
embeddingTimeoutMs: 5000
embeddingCandidateLimit: 128
embeddingCacheSize: 512
minEmbeddingSimilarity: 0.45
usageTracking: true
usageMaxEntries: 1000
adaptiveRouting: false
adaptiveMaxBoost: 6
adaptiveMinUses: 2
adaptiveHalfLifeDays: 30
routes: []
```

如果已知任务必须优先使用特定 Skill，可添加有序规则：

```yaml
routes:
  - matchAll: [pdf, 分析]
    skills: [pdf-reader, document-parser]
  - matchAny: [react, 前端]
    skills: [react-specialist]
```

每条规则可以包含 `matchAll`、`matchAny` 或同时包含两者。规则结果保持声明
顺序，跳过不存在的 Skill，并继续受 `maxActiveSkills` 限制。

### Hybrid embedding Router

Embedding 路由默认关闭。推荐使用本地 Ollama，避免把任务文本发送给第三方：

```bash
ollama pull embeddinggemma
```

```yaml
routerMode: hybrid
embeddingProvider: ollama
embeddingEndpoint: http://127.0.0.1:11434/api/embed
embeddingModel: embeddinggemma
```

使用 OpenAI-compatible embedding 服务时，配置其准确 endpoint：

```yaml
routerMode: hybrid
embeddingProvider: openai-compatible
embeddingEndpoint: https://provider.example/v1/embeddings
embeddingModel: provider-embedding-model
embeddingApiKeyEnv: SKILLFLUX_EMBEDDING_API_KEY
```

请在启动 DSH 的进程环境中设置对应变量。SkillFlux 不保存该值。候选向量只保留
在有界内存 LRU 中，插件停止后自动释放。端点不可用、响应异常、超时或模型维度
变化时，Router 会自动回退到词法结果。

### 使用统计与自适应路由

使用统计按精确 candidate ID 记录成功挂载和成功的 `skill({ name })` 加载。
统计默认开启，自适应路由默认关闭：

```yaml
usageTracking: true
adaptiveRouting: true
adaptiveMaxBoost: 6
adaptiveMinUses: 2
adaptiveHalfLifeDays: 30
```

记录通过原子替换写入 `$DSH_HOME/storages/skillflux/usage.json`（通常是
`~/.dsh/storages/skillflux/usage.json`），并受 `usageMaxEntries` 限制。
文件还有 2 MiB 的硬上限；达到任一上限时优先淘汰最近最少使用的记录。
SkillFlux 只保存 candidate ID、Skill 名称、来源类型、来源、计数和时间戳；不会
保存任务文本、Skill 指令或资源。

加分不超过 `adaptiveMaxBoost`，至少成功加载 `adaptiveMinUses` 次后才生效，
连续 `adaptiveHalfLifeDays` 未使用时减半。统计读写失败只会回退到普通路由，
不会中断 Agent。设置 `usageTracking: false` 可关闭持久化，此时
`adaptiveRouting` 也必须保持关闭。

### 审批策略

| 策略 | 行为 |
| --- | --- |
| `always` | 每次远程挂载都请求 DSH 原生审批；默认值。 |
| `session` | 同一仓库首次成功安装需要审批，之后仅在当前 session 内信任。 |
| `automatic` | 无需审批，自动下载并挂载排名最高的远程候选；仅在可信环境使用。 |

审批服务不可用、拒绝或取消时，SkillFlux 会拒绝远程挂载，且不会记录会话信任。

## 模型工具和用户命令

模型可以使用：

- `skill({ name })`：加载当前回合已经挂载的 Skill 指令。
- `skillflux_search({ query, remote? })`：搜索本地、缓存和不可变远程候选。
- `skillflux_mount({ candidateId })`：挂载当前 SkillFlux 发现状态中的候选。

用户可以使用：

```text
/skillflux status
/skillflux explain
/skillflux usage
/skillflux cache list
/skillflux cache clean <cache-id>
/skillflux cache clean all
```

`explain` 会展示候选的 Router 阶段、总分、基础分、自适应加分，以及它只是被
选中还是已经成功挂载。

清理时会跳过仍在挂载的缓存。到达 `turn/end` 时，SkillFlux 注销运行时挂载，
但保留下载文件供下次复用。

## 安全与信任

- 远程发现只接受 skills.sh 返回的公开 GitHub `owner/repository`。
- 每个远程结果先解析为 40 位 commit SHA，再生成 candidate ID。
- 通过固定的 `skills@1.5.23` CLI 下载该 SHA 对应的不可变 GitHub codeload
  归档。
- 运输归档最多解包 5,000 个文件。最终采用的单个 Skill 默认限制为 1,000 个
  文件和 10 MiB。
- 挂载前检查路径、符号链接、frontmatter、文件数、总字节数和 SHA-256 内容
  manifest。
- SkillFlux 会缓存脚本资源，但不会执行它们。
- 自动发现只发送长度受限的关键词，不发送完整用户消息。
- Hybrid 路由最多向配置的 embedding endpoint 发送 1,000 个字符的直接任务，
  以及每个候选最多 1,000 个字符的名称、`whenToUse` 和 description；不会发送
  Skill 正文或资源。
- 使用统计不包含任务文本或 Skill 内容，并限制在 DSH 存储目录中的
  `usageMaxEntries` 条记录以内。
- 可选的 `GITHUB_TOKEN` 或 `GH_TOKEN` 只用于 GitHub API 限流，不会持久化。

Skill 本质上仍是交给 Agent 的外部指令，可能包含恶意内容。审批是信任决策，
不是沙箱。建议保留 DSH 权限、沙箱和工具审批。

## 测评

无需 API Key 或网络即可运行版本化路由测评：

```bash
corepack pnpm eval
```

测评包含 36 个词法场景、4 个自适应安全场景和 8 个与 Provider 无关的语义向量
场景，覆盖英文、中文、文本归一化、规则优先级、阈值、容量限制、同分排序、
同名去重、语义 Top-K 和负例拒绝。

| 指标 | 当前基线 |
| --- | ---: |
| 完整顺序匹配率 | 100.0% |
| 正例 Top-1 准确率 | 100.0% |
| 无关任务拒绝率 | 100.0% |
| Selector 容量限制合规率 | 100.0% |
| 语义完整顺序匹配率 | 100.0% |
| 语义正例 Top-1 | 100.0% |
| 语义负例拒绝率 | 100.0% |

这些结果验证确定性 Router 和向量排序契约。语义向量是合成数据，不代表某个
embedding 模型、第三方 Skill 质量或在线模型最终回答质量。测评格式和限制见
[测评集说明](evals/README.md)。

## 已知限制

- Hybrid 效果取决于配置的 embedding 模型，SkillFlux 不负责下载或管理模型。
- 语义补位最多处理当前 Registry/缓存顺序中的 `embeddingCandidateLimit` 个本地
  候选。
- 远程安装仅支持 skills.sh 发现的公开 GitHub Skill。
- 卸载无法删除已经写入 session history 的文本。
- 上游出现新 commit 时会形成新的不可变缓存；旧版本需要用户主动清理。

## 开发与测试

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm eval
corepack pnpm test:embedding-live
corepack pnpm pack --dry-run
```

`test:embedding-live` 要求配置的 Ollama 模型已经存在。测试其他 endpoint 时可通过
`SKILLFLUX_EMBEDDING_MODEL`、`SKILLFLUX_EMBEDDING_ENDPOINT` 和
`SKILLFLUX_EMBEDDING_PROVIDER` 覆盖默认值。

测试覆盖路由、DSH 目录虚拟化、显式调用、远程响应校验、缓存完整性、生命周期
清理、有界使用存储、自适应阈值安全和 Bundle patch。提交修改前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
