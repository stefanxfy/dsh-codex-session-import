# Codex Recent Import：公开实现契约

本契约描述 **0.1.15** 的实际边界，供维护者开发及回归验证；不是某台机器的安装报告。用户流程见 [README.md](<README.md>)。ESM JavaScript，Node.js >=24，宿主要求以 [package.json](<package.json>) 为准，运行时会话格式必须为 v4。

## 1. 意图与禁止项

将用户显式选择的本地 Codex 主会话近期历史，冷导入已有 DSH 目标工作区。前端仅提供主会话，固定排除归档及独立子代理；主日志已有的协作调用／返回作为历史保留，不递归导入子会话、不恢复多代理状态。底层扫描兼容参数不等于前端提供开关。

禁止修改源日志、覆盖已有会话、执行历史工具、注册旧工具定义、自动启动 agent／发送提示／续跑、迁移记忆／Skills／自动化。历史文本不得升级为当前系统指令、执行授权或已验证事实。开发测试不得默认安装插件、调用真实模型、读取私有日志或写入真实会话。

## 2. 来源发现与身份

[source-root.js](<src/source-root.js>) 提供 `discoverCodexRoot({manual,home,env})`：已应用手动目录 → 后台进程 CODEX_HOME → 当前用户默认 .codex。候选必须绝对、可读，并含可读 sessions 或 archived_sessions；手动无效报错，自动候选可回退。手动来源只存私有配置，不修改系统环境。切换来源使旧预览失效，预览／导入忙碌时阻止切换。

Windows 本机路径与 WSL UNC 按后台平台语义访问，WSL 内后台使用 Linux 路径；不启动 WSL、不自动挂载、不执行 shell 配置、不自动转换任意平台路径。路径语义模拟测试不是 Windows／WSL 实机验收。

[core.js](<src/core.js>) 提供 `scanCodex({home,codexHome,includeArchived=false,includeSubagents=false,signal})`，返回 workspaces 与 sessions。客户端提交扫描产生的不透明 sessionId，不接受任意源文件路径。路径规范化后必须位于所选来源的会话目录内。

**扫描及准备都以日志自身首个会话头 session_meta 定身份**，后续继承的父元数据不覆盖 id、标题或子代理分类。标题使用可用索引／头部／首个真实用户正文等回退，不自动追加适配后缀；合法同名主会话／用户分支不得按标题合并或删除。

## 3. 解析与固定快照

`prepareSession({path,home,codexHome,keepTurns=30,historyMode="summary",toolOutputChars=8000,presentation="audit",signal,...})` 返回 Prepared：source（身份、路径、工作区、标题、固定 bytes／SHA-256／时间）、turns、olderChunks、stats、warnings，以及适配信息。Turn 包含真实用户及 assistant／tool 历史项；可读 reasoning 独立保留。

keepTurns 为整数 1–500，默认 30；toolOutputChars 为整数 256–64000，默认 8000。真实用户消息开轮；环境／运行时注入过滤或标明，混合消息中的真实用户正文保留。event_msg 镜像及 compacted replacement 不重复追加。缺失祖先前缀明确告警，不声称完整恢复；图片使用占位与告警，加密内容不解密。

固定源字节范围并计算 SHA-256，后续追加不纳入快照，固定前缀改写或截短不得静默接受。大文件逐行读取、近期轮次有界；旧摘要块仍占内存，不宣称无限规模支持。工具输出首尾裁剪并标明丢弃量，参数 JSON 不切坏；未配对工具历史用带说明历史项保留。

## 4. 本地阅读适配与审计兼容

[adapt.js](<src/adapt.js>) 转换版本为 `readable-v2`。前端默认显式请求 readable；API 省略 presentation 时保持 audit 默认及原审计格式兼容。

阅读适配是本地确定性转换，不调用模型、不生成新的推理或结论。每会话安全说明及每轮历史工具摘要不可执行；运行时工具定义移入有界详情，普通代码／JSON 讨论不得误删。结构化 agent_message 转为中文不可执行协作说明，内部 ID／路由／脱敏结构只进有界详情，不把整段内部 JSON 塞入正文。

源中已有可读推理摘要保留在 DSH 原生 reasoning／思考区，不重复英文正文标签；不可读加密内容仅说明不可读。折叠不代表减少 token。前后端握手必须匹配 readable-v2，缺失时阻止阅读预览／导入，不静默降级。转换版本参与摘要缓存与去重；新版不重写旧会话。

## 5. 摘要双阶段授权

[summary.js](<src/summary.js>) 提供 `summarizeChunks(chunks,{generate,signal,onProgress,cache,cacheKey})`，generate 由宿主模型适配器提供。对完整旧历史做有界分块 map/reduce、取消、缓存及失败处理；truncate 或 olderTurns=0 时不得调用模型。summary 为早期历史默认策略，不是 readable-v2 的同义词。

1. preview 默认 confirmSummary=false，只本地估算 inputChars、chunks、estimatedInputTokens、modelKey。存在早期历史时返回 needsSummaryConfirmation=true，**无模型调用、无可导入令牌**。
2. 用户明确费用／数据发送二次确认，提交 confirmSummary=true、expectedSourceSha256、expectedModelKey；缺失或不匹配以 ESTIMATE_CHANGED 拒绝，必须先于模型调用。
3. 使用 DSH 默认模型路由及推理级别，生成完成才返回最终 previewId。摘要是有损历史说明，不验证源断言、不授权旧命令；估算不是精确账单。

缓存键包括快照、路由、配置、提示词及转换版本。分块成功即缓存，失败重试可复用，淘汰后可能重新计费。

## 6. 服务、详情、写入与去重

[host.js](<src/host.js>) 提供 `createService(deps,config)`：scan、resetPreviews、preview、details、start、status、cancel、dispose。依赖由工作区注册表、官方 Session v4、持久化及模型／缓存适配器注入。

- resetPreviews 返回 batchId／limits，只重置未提交预览及容量预留，不清 manifest／摘要缓存；忙碌时拒绝。前端携带 batchId，选择／目标／参数变化需重新预览。
- 默认预览空闲 TTL 15 分钟、最多 24 份、合计 64 MiB，模型调用前预留容量；活动批次续租，不静默淘汰本批令牌。摘要超时默认 30 分钟，缓存默认最多 4096 项。
- details 接收 previewId 或 importedId、offset、limit（最多 20）；重验固定前缀／SHA，返回有界只读页，不调用模型／写会话。缺失来源、旧记录无快照或转换版本不一致须明示，区分 importedConversionVersion 与 parsedConversionVersion。
- start 接收 previewIds 与必选 targetWorkspaceId；拒绝缺失、过期或未完成确认的预览。逐项顺序处理、错误隔离，取消保留完成项，失败不记成功。
- [events.js](<src/events.js>) 的 buildEvents 产生 v4 历史事件：单个空 system 头、递增序号／时间、唯一轮次、已结束 assistant 消息；工具历史不执行。摘要作为历史上下文加到保留用户消息，不伪造助手回答。
- 官方 Session.create 校验后依序持久化 create／append／flush／close，再 attachSession。绑定失败报告孤立制品标识，不未经核实自动删除。目录刷新失败不抹去已完成写入。

manifest 按源快照、选项／转换版本及目标去重，相同组合跳过、不覆盖；**不查询 DSH 归档／删除状态，也无强制重新导入功能**。目标删除后原记录仍可能阻止相同组合再次导入。标题相同不等于同一快照；manifest 保存失败必须警告重启后重复风险。

私有数据默认位于用户主目录的 .dsh/codex-recent-import/，包含来源配置、摘要及导入记录；原子写入并请求目录 0700／文件 0600，实际权限语义视平台而定。不向错误日志输出原始会话正文，不新增评分或遥测。

## 7. RPC 与界面

[index.js](<index.js>) 使用宿主 Connection 共享 /api 的 owner-only 精确 POST 路由：sessions、resetPreviews、preview、details、jobs、status、cancel。保留 client-request／server-response 信封和请求关联；不另开未认证 loopback 服务，不替换共享鉴权。

[client.js](<client.js>) 使用宿主 `connection.rpc.call("/api","codex-recent-import/"+endpoint,...)`，左侧正式 sidebar.panellist 导航与主页面配对，入口“Codex 会话导入”，不占 session action。目标未选在下拉框及底部提示、不代选，无目标提示先创建／打开再刷新。

流程固定为 preview → 摘要费用二次确认（如需）→ start。打开不自动摘要或导入；仅在活跃任务有界轮询并清理。历史正文安全文本渲染，不使用 transcript 的 innerHTML。已导入列表来自 manifest，不证明目标会话仍存在。

## 8. 开发验收与公开分发

现有 scripts 与包白名单见 [package.json](<package.json>)：

```sh
npm test
npm run check
npm run check:package
npm pack --ignore-scripts --dry-run
npm pack --ignore-scripts
```

普通测试以合成数据、假模型与假持久化覆盖轮次、截断、双阶段摘要、取消、部分失败、去重、身份、协作适配、快照及 RPC。真实 DSH SDK／原生 Session 测试仅在安装 DSH 且满足对应 SDK／Electron 条件时运行；条件不足明确 skip，不计为通过。当前原生测试有 macOS 安装布局假设，不承诺跨平台原生覆盖。离线测试通过不等于真实 GUI、Windows／WSL 实机或 CI 验收，不使用私有日志补造证据。

打包前核对文件白名单：无会话、缓存、真实样本、真实标题／标识或机器专用脚本。installer、proof 与历史 docs 留本地并由忽略规则排除，不是公开开发／运行依赖，不链接私有核验产物。截图仅用合成或充分脱敏样本。本契约不要求安装、真实模型调用、提交、推送或新增 CI。

本项目采用 [MIT](<LICENSE>)；保留 [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>) 的引用及第三方声明，DSH 宿主不随插件分发。
