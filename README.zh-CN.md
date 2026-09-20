# dsh-skillflux

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的动态 Skill
Runtime 管理器。

SkillFlux 不把完整 Skill 池永久暴露给模型。它会针对当前任务选择少量相关
Skill，只在当前回合挂载，并在回合结束后释放挂载。

本地池没有合适结果时，SkillFlux 可以实时搜索 skills.sh 和 GitHub 公共
`SKILL.md`，先用相关性优先的质量分与 30 天仓库活跃度信号排序，再提出固定到
commit SHA 的挂载候选。

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
  -> 有序规则 + 确定性词法 Router（中英文）
  -> 可选的有界使用历史排序与 embedding 语义补位
  -> 本地 Registry + 持久缓存 + 自适应在线发现
  -> 相关性优先的质量排序 + 30 天活跃度信号
  -> 通过 Skill Provider 发布 1..maxActiveSkills 个元数据摘要
  -> Registry 技能即时挂载；缓存与远程正文保持惰性
  -> Agent 对确切名称调用 `skill` 工具
  -> Provider 按需下载、校验并加载正文
  -> turn/end 释放短名单与 Provider 目录
  -> 按闲置时间、容量和实际使用价值保留或清理下载文件
```

模型可见目录只含摘要。缓存或远程正文只有在模型真正调用 `skill` 时才下载、
按不可变 commit 做 SHA-256 校验并加载；Registry 技能因正文已在本地而即时挂载。
每个已发布候选只属于接收任务的 Agent；回合结束释放不会删除缓存文件，也无法
删除已经写入 session history 的文本。

## 功能

- 先按配置规则路由，再用确定性的英文单词和中文二元词评分。
- 可选根据成功加载记录，为已经通过词法相关性阈值的候选提供少量、随时间衰减
  的排序加分。
- 可选使用本地 Ollama 或 OpenAI-compatible embedding 服务，为尚未填满的目录
  位置补充语义相近 Skill。
- 使用 `maxActiveSkills` 限制模型可见目录。
- 可选使用保守的 token 估算预算限制 Skill 目录提示。
- 从 DSH Registry、SkillFlux 缓存、[skills.sh](https://skills.sh/) 和经过
  身份验证的 GitHub `SKILL.md` Code Search 发现候选。
- 承载通过 MCP Skills 扩展（`io.modelcontextprotocol/skills`）发布的技能：
  与传输无关的客户端为任意已注册 MCP 来源执行列表、校验与内容绑定，并沿用
  相同的审批与信任边界。
- 根据任务相关性、市场安装量、仓库活跃度、stars、forks、license、内容来源及
  owner 策略重新排序，并为每个结果输出可解释的证据等级和告警。
- 将远程候选固定到不可变的 GitHub commit SHA。
- 通过单个 host 级 Skill Provider 按 Agent 解析目录：只发布元数据摘要，缓存
  与远程正文在模型调用 `skill` 时才惰性下载。
- 自适应联网：本地高置信短名单填满全部目录槽位时跳过远程请求；本地命中不足
  时自动联网补齐剩余槽位。
- 跟踪各来源健康状态：连续失败进入冷却期并自动跳过，降级发现发布非权威观测
  以保留 last-good 目录。
- 记录每个 Skill 的目录占用与加载正文 token 遥测，宿主 token-meter 服务缺失
  时优雅降级为可移植估算。
- 通过当前 Agent 的 `ctx.skills` scope 注册缓存 Skill。
- 每次加载前使用 SHA-256 manifest 校验缓存内容。
- 自动清理闲置和低价值的已安装 Skill 缓存，同时保护活动挂载和正在加载的条目。
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
7. 依次发布选中名称，直到达到 `maxActiveSkills`。Registry 名称即时挂载；缓存
   与远程名称只发布摘要，正文在模型调用 `skill` 时惰性加载。启用
   `catalogTokenBudget` 后，如果某候选会使目录提示估算值超过预算，则跳过该候选；
   惰性加载失败时，在同一个安装截止时间内按候选池顺序尝试同名 fallback。

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

## 在线高质量 Skill 发现

远程发现读取实时网络数据，不使用打包在插件里的静态目录：

1. skills.sh 提供市场匹配结果和安装量。
2. 存在 `GITHUB_TOKEN` 或 `GH_TOKEN` 时，GitHub Code Search 会继续发现市场外的
   公共 `SKILL.md`；SkillFlux 会先拉取并校验命中的 frontmatter。
3. GitHub 仓库元数据提供不可变 HEAD commit、stars、forks、license、归档状态、
   owner 类型和最近 push 时间。
4. SkillFlux 拒绝零相关、已归档、已禁用、低于 stars 门槛或低于质量门槛的结果，
   再应用配置的证据策略。
5. 只有 candidate identity 完全相同的重复项会折叠。不同仓库即使根 `SKILL.md`
   哈希相同也会保留，因为相邻资源可能不同；它们也不会被算成独立 provider 交叉
   验证。

质量分最高为 100。相关性既是准入门槛，也是权重最大的单项，因此高 star 但不
相关的仓库不会仅凭热度压过精确匹配的新 Skill。

| 信号 | 最高贡献 |
| --- | ---: |
| 任务与名称/description 的相关性 | 55 |
| skills.sh 安装量 | 15 |
| GitHub stars | 15 |
| GitHub forks | 5 |
| 仓库活跃度，配置的近期窗口权重最高 | 10 |
| 可信 owner、组织归属和 license 元数据 | 15 |
| 跨来源发现与固定的 GitHub 内容预览 | 8 |

`remoteRecentActivityDays` 默认是 30。窗口内活跃可获得完整 freshness 加分；更老但
仍维护的项目会逐步衰减，而不是直接淘汰。只有经过你独立验证的 owner 才应加入
`remoteTrustedOwners`；组织账号或高 stars 本身不等于可信认证。

每个候选会标记为 `unverified`、`community`、`corroborated` 或 `trusted`。
默认的 `remoteTrustPolicy: community` 会保留相关性高、已直接预览并固定内容的
GitHub Skill，即使它刚创建、stars 很少，同时明确暴露 `low-adoption`、缺少
license、活动陈旧和来源覆盖不足等告警。`corroborated` 要求内容已固定且被多个
provider 发现；`trusted` 只表示 owner 在本地 `remoteTrustedOwners` 名单中，
不是安全认证。`remoteBlockedOwners` 是显式拒绝名单；同一 owner 不能同时可信和
拒绝。

这些策略会在每次搜索、自动路由和挂载时重新应用到已安装的 SkillFlux 缓存。把
owner 从 `remoteTrustedOwners` 移除会撤销缓存中的旧 `trusted` 标签；加入
`remoteBlockedOwners` 后，即使重启也不能复用。没有证据标签的旧版缓存 manifest
因已知不可变 commit 和安装目录哈希而按 `community` 处理，但不能通过
`corroborated` 或 `trusted` 门槛。

GitHub Code Search 需要身份验证。请从带有标准环境变量的 shell 启动 DSH，例如
PowerShell：

```powershell
$env:GH_TOKEN = gh auth token
dsh web
```

没有 token 时，SkillFlux 仍会在线搜索 skills.sh，并通过公共 GitHub REST API
补全这些结果；只会跳过范围更广的 GitHub Code Search provider。

### 发现结果缓存

成功的在线搜索会跨 DSH 重启缓存。默认 5 分钟 TTL 可避免同类任务反复调用市场
和 GitHub API。TTL 过期后 SkillFlux 会重新查询 provider；如果刷新失败，可以在
额外 24 小时内复用此前的不可变候选。用户主动取消时绝不会回退到 stale 结果。

缓存 key 是“有界归一化查询 + 当前发现与排序配置”的 SHA-256 指纹，不保存用户
任务原文、token 或 Skill 正文。候选仍固定在最初验证过的 commit，因此 stale
回退只影响排名证据的新鲜度，不改变源码完整性或审批对象。

证据感知的缓存文档带有版本号；旧排序缓存不会套用新的信任语义，而是丢弃并通过
在线查询重建。

缓存通过原子替换写入
`$DSH_HOME/storages/skillflux/remote-discovery.json`，默认最多 100 条，并有
4 MiB 硬限制。设置 `remoteCacheTtlMs: 0` 可完全关闭。

### 自适应在线发现

`remoteDiscovery: automatic` 时，SkillFlux 仅在需要时才联网。本地高置信短名单
填满全部目录槽位时会完全跳过远程请求；本地路由仍有空缺或一无所获时，再从
skills.sh 与 GitHub 搜索补齐剩余槽位（受 `maxActiveSkills` 与
`remoteAutoMountLimit` 约束）。

每个来源都有健康状态。连续失败达到 `remoteHealthFailureThreshold` 后，该来源
进入 `remoteHealthCooldownMs` 冷却期并被跳过，因此故障会降级为“健康来源 + 发现
缓存”，而不是每回合重试。成功调用会清空失败记录。发现降级或回退到 stale 缓存
候选时，发布目录被标记为非权威观测：注册表保留 last-good 目录，同时仍可用的
候选继续可见。`/skillflux status` 会按来源报告失败次数与降级状态。

### 已安装 Skill 缓存治理

下载后的 Skill 单独保存在 `$DSH_HOME/cache/skillflux`。每当远程 Skill 成功挂载，
SkillFlux 会评估已安装缓存，并在该 session 的回合结束、释放挂载后再次检查。
默认先清理连续 90 天未活动的条目；如果剩余缓存仍超过 100 项或 512 MiB，再按照
成功调用 Skill 工具的次数、挂载次数、最近活动时间、质量分和采用度等确定性证据，
从低价值条目开始淘汰。

首次远程候选与后续缓存候选的使用记录会按不可变 cache ID 聚合，既能跨越二者
不同的 candidate ID，又不会让同一 Skill 的不同 commit 共享价值。旧版中没有
cache ID 的记录只归入匹配仓库和 Skill 的最新版本。共享 usage 文件的更新会在
Harness 进程之间加锁并合并。当前已经挂载和并发加载中的缓存会跨 Service 实例和
共用 `DSH_HOME` 的 Harness 进程受到保护。lease 心跳会在
崩溃进程的 PID 被复用时限制孤儿 marker 的保留时间；进程内 live-lease 注册表
允许热重载后的 Service 回收已经释放的 marker。自动治理失败只记录警告；协调锁
失效时会终止当前缓存操作，不会在失去互斥保护后继续执行。

使用 `/skillflux cache prune` 可以立即执行同一套策略。设置
`cacheAutoPrune: false` 可关闭自动执行；设置 `cacheMaxIdleDays: 0` 可关闭按闲置
时间淘汰，同时保留条目数和总字节限制。关闭 `usageTracking` 后没有本地使用
证据，治理会保守地退回安装时间和不可变发现元数据。
manifest 无效的目录不会被自动删除；`/skillflux status` 会报告其数量，用户可用
`/skillflux cache clean all` 明确清理。

## 配置

SkillFlux 支持以下插件配置：

```yaml
maxActiveSkills: 3
minRouteScore: 8
approvalPolicy: always       # always | session | automatic；约束惰性远程激活与显式挂载
remoteDiscovery: automatic   # automatic（自适应）| on-demand | off
remoteProviders: [skills.sh, github]
remoteSearchLimit: 5
remoteAutoMountLimit: 3      # 惰性激活发布的远程候选上限；设为 1 可关闭候选回退
remoteSearchTimeoutMs: 30000
remoteMinQualityScore: 35     # 0-100
remoteMinStars: 0
remoteRecentActivityDays: 30
remoteTrustPolicy: community  # open | community | corroborated | trusted
remoteTrustedOwners: []       # 例如 [anthropics, openai, vercel-labs]
remoteBlockedOwners: []
remoteCacheTtlMs: 300000                  # 0 表示关闭
remoteCacheStaleIfErrorMs: 86400000       # TTL 后的额外 stale 窗口
remoteCacheMaxEntries: 100
remoteHealthFailureThreshold: 3           # 连续失败多少次后降级该来源
remoteHealthCooldownMs: 60000             # 降级来源的跳过窗口
cacheAutoPrune: true
cacheMaxEntries: 100
cacheMaxTotalBytes: 536870912              # 已安装 Skill 合计 512 MiB
cacheMaxIdleDays: 90                       # 0 表示关闭按闲置时间淘汰
catalogDescriptionMaxLength: 160
catalogTokenBudget: 0              # 0 表示关闭；否则为 64-1000000
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
mcpDiscovery: automatic        # automatic | off；控制已注册 MCP Skills 来源
mcpTrustedServers: []          # 允许携带 trusted 证据的主机指定来源标签
mcpBlockedServers: []          # 始终拒绝的主机指定来源标签
registryDiscovery: off         # off | automatic；实验性的联邦索引摄入
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
SkillFlux 只保存 candidate ID、Skill 名称、来源类型、来源、计数、token 计数和
时间戳；不会保存任务文本、Skill 指令或资源。

加分不超过 `adaptiveMaxBoost`，至少成功加载 `adaptiveMinUses` 次后才生效，
连续 `adaptiveHalfLifeDays` 未使用时减半。统计读写失败只会回退到普通路由，
不会中断 Agent。设置 `usageTracking: false` 可关闭持久化，此时
`adaptiveRouting` 也必须保持关闭。

### Token 遥测

当宿主挂载了 DSH 的 token-meter 服务时，SkillFlux 会用原生估算器为目录条目
和每次加载的 SKILL.md 正文计价；服务缺失时回退到目录预算使用的同一套可移植
估算（`ceil(UTF-8 字节数 / 3)`）。该集成不新增任何包依赖：可选的
`ctx.tokenMeter` 服务在运行时解析，任何失败都会静默降级为可移植估算。

每个 Skill 的 token 计数会追加到使用统计，并显示在 `/skillflux status` 和
`/skillflux usage` 中：最近一次挂载的目录占用、最近一次加载的正文 token 及
累计值，以及产生这些数字的估算器。持久化只包含 token 计数；任务文本、Skill
指令和资源绝不会写入 `usage.json`。当两个已安装缓存版本在最近使用、次数和
挂载次数上完全相同时，裁剪会优先淘汰累计正文 token 更高的版本；该顺序是
确定性的，缺少证据时保持历史顺序不变。Token 遥测不会改变路由或审批决策。

### 目录上下文预算

`catalogTokenBudget` 是 `maxActiveSkills` 之外的可选第二重限制。默认值 `0`
保持现有行为不变。设置非零值后，每次挂载都会先检查目录估算值；只跳过导致超额
的候选，后续更小的候选或同名 fallback 仍可继续尝试：

```yaml
maxActiveSkills: 3
catalogDescriptionMaxLength: 160
catalogTokenBudget: 512
```

估算范围是 description 截断后的完整“替换型”Skill 目录提示，算法为
`ceil(UTF-8 字节数 / 3)`。它对常见英文偏保守，对中文约等于每字一个 token，
但不是特定模型 tokenizer 的精确结果。`/skillflux status` 会显示当前估算值，
`/skillflux explain` 会把因预算跳过的候选标记为 `budget-skipped`。

### 审批策略

| 策略 | 行为 |
| --- | --- |
| `always` | 每次远程挂载都请求 DSH 原生审批；默认值。 |
| `session` | 同一仓库首次成功安装需要审批，之后仅在当前 session 内信任。 |
| `automatic` | 无需审批，按排名尝试远程候选，首次挂载成功即停止；仅在可信环境使用。 |

审批服务不可用、拒绝或取消时，SkillFlux 会拒绝远程挂载，且不会记录会话信任。

### 自动远端候选回退

仅在 `approvalPolicy: automatic` 下，首个候选不可用时会按发现顺序尝试后续候选，
首次挂载成功即停止。`remoteAutoMountLimit` 默认为 **3**，允许 **1–5**；设为 `1`
可保留只尝试一个候选的行为。

多次尝试共享一个 `installTimeoutMs` 预算，从搜索结束后开始计时。预算用尽、用户
显式取消或回合结束后，不再发起下一个尝试。在途的锁获取和清理会等待安全结束，
因此该预算不保证整个过程在精确的墙钟时间内返回。

每个候选仍须通过当前信任与 owner 策略、固定版本源码验证、安装内容校验和目录
预算检查。`/skillflux explain` 会记录 `mount-failed`、`mount-timeout`、
`budget-skipped` 或 `mounted`。失败候选不再出现在本回合提示中，尚未尝试的候选
仍可使用；重新执行 `skillflux_search` 可以重试，不会形成持久黑名单。
`always`、`session` 和显式 `skillflux_mount` 的审批行为不变，也不会静默换候选。

### MCP Skills 来源

SkillFlux 可以承载通过 MCP Skills 扩展（`io.modelcontextprotocol/skills`，
SEP-2640）发布的技能。与传输无关的 `McpSkillsClient` 会在任意注入的传输层上
调用 `skills/list`、`skills/get` 与 `resources/read`；主机为每个来源分配一个稳定
标签，该标签是每个技能身份中的来源半边：

```ts
import { McpSkillsClient, McpStdioTransport } from 'dsh-skillflux'

// 随包的零依赖 stdio 传输通过 LSP 风格的 Content-Length 帧 JSON-RPC
// 与子进程 MCP 服务器通信。
const transport = new McpStdioTransport({ command: 'node', args: ['server.mjs'] })
ctx.skillFlux.registerMcpSource('docs-server', new McpSkillsClient(transport))
```

SSE 与 Streamable HTTP 传输仍由接入方提供：实现 `McpTransport` 的
`request(method, params)` 后传给 `McpSkillsClient` 即可。`pnpm test:mcp-live`
会针对随包的一致性服务器验证 stdio 传输，并包含篡改 digest 的 fail-closed
场景。

列表与远程候选走相同的信任与审批边界。每个条目都按扩展契约校验，`resources`
为 `"dynamic"` 的技能因无法内容绑定而被拒绝；审批绑定到排序后的
`[uri, digest, size]` 集合。文件通过 `resources/read` 惰性获取，逐字节校验
digest 与 size，再把 SKILL.md 的 frontmatter 与条目逐字段比对，最终落到一个编码
了来源标签、SKILL.md URI 与内容绑定键的缓存 id 下；内容变化会落到新 id，绝不
覆盖已审批快照。MCP 内容始终带有来源标签，发现与加载期间从不执行，也不会静默
遮蔽其他来源的同名技能。无法列出某个来源时，本回合 fail-open 并标记为
非权威观测。

### 联邦注册表索引（实验性）

`registryDiscovery: automatic`（默认关闭）允许宿主注册联邦生态索引，其条目会
进入与其他远程候选完全相同的不可变 commit、证据与审批管线：

```ts
import type { RegistryIndexTransport } from 'dsh-skillflux'

const transport: RegistryIndexTransport = { list: () => index.fetch() }
ctx.skillFlux.registerRegistryIndex('ds-ecosystem', transport)
```

每个条目固定到 40 位 commit，并携带咨询性的
`official | verified | community | unreviewed` 层级。层级只作为质量信号与
告警出现：它绝不授予信任、绝不绕过 `remoteTrustPolicy` 或屏蔽 owner，也不
改变内容固定的要求。部分或失败的索引列表会降级发现观测，但不会削弱保留下来的
候选。索引查询从不持久化。

## 模型工具和用户命令

模型可以使用：

- `skill({ name })`：加载当前回合已经挂载的 Skill 指令。
- `skillflux_search({ query, remote? })`：搜索本地、缓存和不可变远程候选；远程
  结果包含评分分项、证据等级、正向信号和告警。
- `skillflux_mount({ candidateId })`：挂载当前 SkillFlux 发现状态中的候选。

用户可以使用：

```text
/skillflux status
/skillflux explain
/skillflux usage
/skillflux cache list
/skillflux cache prune
/skillflux cache clean <cache-id>
/skillflux cache clean all
/skillflux discovery-cache status
/skillflux discovery-cache clean
```

`explain` 会展示候选的 Router 阶段、总分、基础分、自适应加分，以及它只是被
选中、已经成功挂载，还是因为目录预算被跳过。

清理和治理都会跳过已挂载或正在加载的缓存。到达 `turn/end` 时，SkillFlux 注销
运行时挂载；已安装文件会保留到后续策略执行或用户主动清理。

## 安全与信任

- 远程发现只接受 skills.sh 或经过身份验证的 GitHub `SKILL.md` Code Search 返回的
  公共 GitHub 仓库。
- GitHub 发现的 `SKILL.md` 会通过经过身份验证的 Contents API 从固定 commit 读取，
  限制为 256 KiB，并且必须先通过同一套 frontmatter parser，才能成为候选。
- 每次新安装前，SkillFlux 都会通过 GitHub tree API 枚举固定 commit 中最多 512 个
  `SKILL.md`，再通过 Git Blob API 读取 tree 绑定的精确 blob SHA，并要求目标名称只
  对应一个可用 Skill；随后只选择该 Skill 目录下的常规文件。skills.sh-only 与
  GitHub Code Search 结果都执行该检查，不依赖 `raw.githubusercontent.com`。
- 已验证源文件的 SHA-256 必须同时匹配之前的 GitHub 搜索预览（若有）和安装器最终
  选中的 `SKILL.md`。因此同一仓库多个路径中的同名文件即使根文件字节相同也会因
  歧义被拒绝，因为相邻资源仍可能不同。
- 没有完整 Skill 目录哈希时，跨仓库相同根文件哈希不会被折叠或称为镜像。
- 已归档和已禁用仓库会被拒绝。热度、活跃度和 license 只是排序证据，不是安全
  审计结论。
- `remoteTrustPolicy` 是证据门槛，不是恶意代码扫描器；`trusted` 只反映当前本地
  配置的 owner 白名单，证据门槛与拒绝名单也会治理已安装 SkillFlux 缓存的复用。
- 每个远程结果先解析为 40 位 commit SHA，再生成 candidate ID。
- 内置安装器只下载上述目标 Git blobs，逐个核验响应声明的字节数和重新计算的 Git
  blob SHA，并按不可执行的常规文件写入；不会下载或解包整个仓库归档。
- 下载前依据固定 tree 检查文件数和总字节数，落盘后再检查一次。单个 Skill 默认
  限制为 1,000 个文件和 10 MiB。
- 挂载前检查路径、符号链接、frontmatter、文件数、总字节数和 SHA-256 内容
  manifest。
- SkillFlux 会缓存脚本资源，但不会执行它们。
- 自动发现只发送长度受限的关键词，不发送完整用户消息。
- Hybrid 路由最多向配置的 embedding endpoint 发送 1,000 个字符的直接任务，
  以及每个候选最多 1,000 个字符的名称、`whenToUse` 和 description；不会发送
  Skill 正文或资源。
- 使用统计不包含任务文本或 Skill 内容，并限制在 DSH 存储目录中的
  `usageMaxEntries` 条记录以内。
- 已安装缓存治理只读取这些有界使用计数和不可变缓存元数据，不检查也不保存任务
  原文。
- 远程发现缓存只持久化查询/配置指纹和有界、经过校验的候选元数据，不保存查询
  原文或 API 凭据。
- MCP Skills 来源只以主机分配的标签寻址，绝不使用服务器自报名称。条目先通过
  校验才能成为候选，`"dynamic"` 技能被拒绝，加载的每个字节都要对照持有的
  `[uri, digest, size]` 集合并逐字段比对 frontmatter。审批绑定该内容集合；集合
  变化会落到新缓存 id 并需要重新审批，缓存文件每次加载都会重新计算 digest，
  且绝不获得本地文件系统技能的信任。
- 可选的 `GITHUB_TOKEN` 或 `GH_TOKEN` 会启用 GitHub Code Search 和批量仓库
  元数据补全；SkillFlux 不会持久化它。

Skill 本质上仍是交给 Agent 的外部指令，可能包含恶意内容。审批是信任决策，
不是沙箱。建议保留 DSH 权限、沙箱和工具审批。

审批同样保护惰性激活。已发布的远程候选在模型调用 `skill` 之前不会下载任何
内容；配置的审批策略会在该边界、下载发生之前生效。没有可用审批通道时按
fail-closed 拒绝，而不是未经同意安装。被屏蔽或证据不足的 owner 不会进入发布
目录。

## 测评

无需 API Key 或网络即可运行版本化路由测评：

```bash
corepack pnpm eval
```

测评包含 40 个词法场景、4 个自适应安全场景、8 个与 Provider 无关的语义向量
场景、7 个目录预算场景、8 个远程质量两两对比场景、8 个远程证据治理场景、
7 个远程缓存策略场景、8 个惰性远程回退场景、7 个已安装缓存治理场景和
7 个 Provider 原生惰性运行时场景、12 个 MCP 来源条目契约场景，
覆盖英文、中文、文本归一化、规则优先级、阈值、容量限制、同分排序、同名去重、
语义 Top-K、上下文预算、freshness、可信度、采用度、缓存过期、价值淘汰、
活动挂载保护、惰性下载、审批、并发隔离、取消传播与负例拒绝。

| 指标 | 当前基线 |
| --- | ---: |
| 完整顺序匹配率 | 100.0% |
| 正例 Top-1 准确率 | 100.0% |
| 无关任务拒绝率 | 100.0% |
| Selector 容量限制合规率 | 100.0% |
| 语义完整顺序匹配率 | 100.0% |
| 语义正例 Top-1 | 100.0% |
| 语义负例拒绝率 | 100.0% |
| 远程质量两两排序正确率 | 100.0% |
| 远程证据治理边界正确率 | 100.0% |
| 远程缓存策略边界正确率 | 100.0% |
| 已安装缓存治理边界正确率 | 100.0% |
| MCP 来源条目契约正确率 | 100.0% |

这些结果验证确定性 Router 和向量排序契约。语义向量是合成数据，不代表某个
embedding 模型、第三方 Skill 质量或在线模型最终回答质量。测评格式和限制见
[测评集说明](evals/README.md)。

## 从 v0.2 迁移

v0.3 将 SkillFlux 变为 Provider 原生惰性运行时。大部分配置保持不变，差异在
行为层面：

- 自动路由不再预下载远程候选，而是发布元数据摘要；正文在模型调用 `skill`
  时才下载、校验并加载。`remoteAutoMountLimit` 现在限制“为惰性激活发布的
  远程候选数量”（设为 1 可关闭同名回退），而不是预安装数量。
- Registry 技能仍然即时挂载；缓存与远程技能以摘要形式出现在目录中并按需加载。
- 审批同样作用于惰性激活：`always` 或 `session` 策略下，远程候选首次 `skill`
  调用会在下载前询问。
- 远程发现改为自适应：本地高置信短名单直接跳过联网，本地部分命中自动补齐
  剩余槽位，故障来源进入冷却而非每回合重试；降级或 stale 发现发布非权威观测，
  使 last-good 目录在故障期间存活。
- 路由痕迹新增 `loaded` 结果，表示惰性加载成功。
- bundle patch 会禁用官方 DSH `tool-skill` 消费者，改用 SkillFlux 自己的过滤
  目录。

## 从 v0.3 迁移

v0.4 新增两个可选子系统，现有配置与行为全部保持兼容：

- MCP Skills 来源。调用 `ctx.skillFlux.registerMcpSource(label, client)`，
  传入与传输无关的 `McpSkillsClient`，即可承载通过 MCP Skills 扩展发布的
  技能。条目先通过校验，内容按其 `[uri, digest, size]` 集合绑定，并沿用与
  远程候选相同的审批与信任策略。新增配置键：`mcpDiscovery`、
  `mcpTrustedServers`、`mcpBlockedServers`。stdio 传输已随包提供；
  SSE/HTTP 传输仍由接入方提供。
- Token 遥测。宿主挂载 DSH token-meter 服务后，使用统计会新增每个 Skill 的
  目录占用与加载正文 token 计数以及估算器标记，并显示在 `/skillflux status`
  与 `/skillflux usage` 中。旧的 usage 文档可直接加载；只存储 token 计数。

## 已知限制

- Hybrid 效果取决于配置的 embedding 模型，SkillFlux 不负责下载或管理模型。
- SkillFlux 注册的是单个 host 级 Provider：作用域 Agent 上下文不暴露
  `ctx.skills`，因此按 Agent 解析的目录通过注册表传入的 lookup scope 路由。
- 语义补位最多处理当前 Registry/缓存顺序中的 `embeddingCandidateLimit` 个本地
  候选。
- MCP 加载内置与传输无关的 JSON-RPC 客户端和随包 stdio 传输；SSE/HTTP 适配器
  暂由接入方提供，`resources` 为 `"dynamic"` 的技能因无法内容绑定而被拒绝。
- 目录 token 数是可移植估算值，不是当前聊天模型 tokenizer 的精确计数；它不
  包含已加载的 Skill 正文、工具 schema 或其他 session history。
- 没有 `GITHUB_TOKEN` 或 `GH_TOKEN` 时无法使用 GitHub Code Search，但
  skills.sh provider 仍可使用。
- 质量分是基于证据的候选筛选，不是代码安全审计。挂载前仍应查看精确固定版本，
  并保持审批与 sandbox 控制开启。
- provider 故障期间，stale 回退可能在配置窗口内返回较旧的排名证据，但候选始终
  固定在此前已验证的不可变 commit。
- 卸载无法删除已经写入 session history 的文本。
- 上游出现新 commit 时会形成新的不可变缓存；价值感知治理可能保留多个版本，
  直到其闲置或超过配置限制。

## 暂缓与范围外

- LLM Router：最近 30 天社区无明显热度，暂不值得引入额外的依赖面。
- GUI 市场：发现仍以 Provider 与工具驱动，不内置界面。
- 重型恶意代码扫描：SkillFlux 保持基于证据的信任与内容校验，但并非代码
  安全审计器。

## 开发与测试

外部协作者请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，其中包含 fork、topic
branch、离线质量门禁、GitHub 联网冒烟测试、评测集更新和 PR 审查流程。

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm eval
corepack pnpm test:cache-governance-live
corepack pnpm test:discovery-live
corepack pnpm test:embedding-live
corepack pnpm pack --dry-run
```

`test:discovery-live` 会执行真实的 skills.sh 查询；存在 `GITHUB_TOKEN` 或
`GH_TOKEN` 时还会测试 GitHub Code Search，并验证第二次相同查询由持久发现缓存
直接返回。可用 `SKILLFLUX_DISCOVERY_QUERY`
替换任务，用 `SKILLFLUX_TRUSTED_OWNERS` 传入逗号分隔的可信 owner，或设置
`SKILLFLUX_BLOCKED_OWNERS` 提供拒绝 owner；`SKILLFLUX_TRUST_POLICY` 可覆盖
smoke test 的证据门槛。设置 `SKILLFLUX_REQUIRE_GITHUB=1`，可让 GitHub
provider 不可用时测试直接失败。

`test:embedding-live` 要求配置的 Ollama 模型已经存在。测试其他 endpoint 时可通过
`SKILLFLUX_EMBEDDING_MODEL`、`SKILLFLUX_EMBEDDING_ENDPOINT` 和
`SKILLFLUX_EMBEDDING_PROVIDER` 覆盖默认值。

测试覆盖路由、DSH 目录虚拟化、显式调用、远程响应校验、发现缓存过期与回退、
安装缓存完整性、生命周期清理、有界使用存储、自适应阈值安全和 Bundle patch。
提交修改前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
