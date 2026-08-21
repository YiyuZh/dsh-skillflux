# dsh-skillflux

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的动态 Skill Runtime 管理器。

`dsh-skillflux` 不把完整 Skill 池永久暴露给模型，而是根据当前回合选择少量相关 Skill，按需挂载本地缓存或远程 Skill，并在回合结束后卸载。下载文件会保留到用户主动清理。

> 当前状态：适配 DeepSeek Harness `0.1.1-rc.1` 的 MVP。Harness 仍处于开发者预览阶段，本项目暂时跟随当前 RC API。

[English](README.md)

## 解决的问题

```text
用户任务
  -> 确定性 Skill Router
  -> 本地 Registry + 持久缓存 + skills.sh
  -> 只挂载最多 1-3 个 Skill
  -> Agent 执行
  -> turn/end 自动卸载
  -> 下载文件保留，等待用户清理
```

SkillFlux 复用官方 `ctx.skills` Registry，只替换默认的模型侧 `tool-skill` 消费层。因此原有文件系统 Provider、Skill 优先级、Agent scope 和显式 `/skill-name` 调用仍然有效。

## MVP 功能

- 配置规则优先，英文单词与中文二元词的确定性评分兜底。
- 模型目录由 `maxActiveSkills` 限制，不随已安装 Skill 总数增长。
- 发现本地 Registry、SkillFlux 持久缓存和 skills.sh 候选。
- 远程候选在展示前固定到 GitHub commit SHA。
- 通过当前 Agent 的 `ctx.skills.register()` 挂载，并保存精确 disposer。
- 在 `$DSH_HOME/cache/skillflux` 保存带内容哈希的持久缓存。
- 三种远程审批策略：每次审批、会话内首次审批、全自动。
- 模型工具：`skill`、`skillflux_search`、`skillflux_mount`。
- 用户命令：`/skillflux` 状态和缓存管理。

## 安装

仓库会提交构建后的 `lib/`，从 GitHub 安装时不需要执行 `prepare`：

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux
```

生产或可复现测试建议固定插件提交：

```bash
dsh plugin --profile web add github:YiyuZh/dsh-skillflux#<commit-sha>
```

插件 bundle patch 会覆盖配置中 `id: tool-skill` 的行，但保留官方 `skill` 和 `skill-filesystem` 服务。安装后重启对应 Harness profile。

## 配置

默认配置：

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
routes: []
```

规则示例：

```yaml
routes:
  - matchAll: [pdf, 分析]
    skills: [pdf-reader, document-parser]
  - matchAny: [react, 前端]
    skills: [react-skill]
```

规则按配置顺序执行，先于词法评分。每条规则可以提供 `matchAll`、`matchAny`，也可以同时提供。结果会按 Skill 名去重，并受 `maxActiveSkills` 限制。

### 审批策略

| 策略 | 行为 |
| --- | --- |
| `always` | 每次远程挂载都进入 DSH 原生单次审批；默认值。 |
| `session` | 同一仓库第一次成功安装需要审批，信任只保留到当前 session 结束。 |
| `automatic` | 最高排名的远程候选可以自动下载和挂载；只应在可信环境使用。 |

审批服务不存在、拒绝或取消时，安装会 fail closed，不产生挂载或会话信任。

## 模型工具与用户命令

模型工具：

- `skill({ name })`：加载当前回合已经挂载的 Skill。
- `skillflux_search({ query, remote? })`：搜索本地、缓存和不可变远程候选。
- `skillflux_mount({ candidateId })`：只挂载 SkillFlux 当前发现状态中存在的候选。

用户命令：

```text
/skillflux status
/skillflux cache list
/skillflux cache clean <cache-id>
/skillflux cache clean all
```

清理时会跳过仍在挂载的缓存。`turn/end` 只注销能力，不删除下载文件；下次匹配时可直接从缓存重新挂载。

## 路由逻辑

1. 用户显式 `/skill-name` 继续使用官方 user-invocable 语义。
2. 依次匹配 `routes`。
3. 对剩余候选进行确定性评分：
   - 完整 Skill 名命中：`+100`
   - 名称词命中：每个 `+20`
   - `whenToUse` 命中：每个 `+8`
   - description 命中：每个 `+3`
4. 低于 `minRouteScore` 的候选不自动挂载。
5. 同分时优先本地 Registry，再选缓存，最后才是远程候选。

## 安全边界

- 远程安装只接受 skills.sh 返回的公开 GitHub `owner/repository`。
- 先通过 GitHub API 将候选解析为 40 位 commit SHA，再生成 candidate ID。
- 使用固定的 `skills@1.5.23` 下载该 SHA 对应的 GitHub codeload 不可变归档。
- 仓库运输归档最多解包 5,000 个文件；最终被采用的单个 Skill 默认仍限制为 1,000 个文件和 10 MiB。
- 挂载前检查路径、符号链接、YAML frontmatter、文件数、总字节数和 SHA-256 内容 manifest。
- SkillFlux 不会自动执行 Skill 中附带的脚本。
- 自动发现只发送长度受限的关键词，不发送完整用户消息，并过滤常见密钥形态。
- 可选的 `GITHUB_TOKEN`/`GH_TOKEN` 只用于 GitHub API 限流，不写入缓存或日志。

Skill 本质上仍是交给 Agent 的外部指令，审批并不等于内容安全。建议保留 DSH sandbox、permission preset 和工具审批。

## MVP 已知限制

- 暂无 embedding 或 LLM Router。
- 远程安装仅支持 skills.sh 发现的公开 GitHub Skill。
- 卸载无法删除已经写入 session history 的文本，但会阻止旧 Skill 继续出现在后续目录。
- 上游出现新 commit 时会形成新的不可变缓存；旧版本需要用户主动清理。

## 开发与测试

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm pack --dry-run
```

测试覆盖中英文路由、100 Skill 目录虚拟化、显式调用兼容、远程响应校验、缓存篡改检测和活动缓存清理保护。

## 许可证

[MIT](LICENSE)
