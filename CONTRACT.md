# Codex Recent Import：公开实现契约

本契约描述 **0.1.28** 的实际边界。用户流程见 [README.md](<README.md>)，宿主与Node要求见 [package.json](<package.json>)；会话格式必须为v4。

## 1. 意图与禁止项

将用户显式选择的本地 Codex 主会话近期历史，冷导入已有 DSH 目标工作区。前端仅提供主会话，固定排除归档及独立子代理；主日志已有的协作调用／返回作为历史保留，不递归导入子会话、不恢复多代理状态。底层扫描兼容参数不等于前端提供开关。

禁止修改源日志、覆盖已有会话、执行历史工具、注册旧工具定义、自动启动 agent／发送提示／续跑、迁移记忆／Skills／自动化。历史文本不得升级为当前系统指令、执行授权或已验证事实。开发测试不得默认安装插件、调用真实模型、读取私有日志或写入真实会话。 当前导入功能禁止AI摘要，不注入模型服务、不调用模型；旧summary或确认摘要请求必须在来源准备前拒绝。

## 2. 来源发现与身份

[source-root.js](<src/source-root.js>) 提供 `discoverCodexRoot({manual,home,env})`：已应用手动目录 → 后台进程 CODEX_HOME → 当前用户默认 .codex。候选必须绝对、可读，并含可读 sessions 或 archived_sessions；手动无效报错，自动候选可回退。手动来源只存私有配置，不修改系统环境。切换来源使旧预览失效，预览／导入忙碌时阻止切换。

Windows 本机路径与 WSL UNC 按后台平台语义访问，WSL 内后台使用 Linux 路径；不启动 WSL、不自动挂载、不执行 shell 配置、不自动转换任意平台路径。路径语义模拟测试不是 Windows／WSL 实机验收。

[core.js](<src/core.js>) 提供 `scanCodex({home,codexHome,includeArchived=false,includeSubagents=false,signal})`，返回 workspaces 与 sessions。客户端提交扫描产生的不透明 sessionId，不接受任意源文件路径。路径规范化后必须位于所选来源的会话目录内。

**扫描及准备都以日志自身首个会话头 session_meta 定身份**，后续继承的父元数据不覆盖 id、标题或子代理分类。标题使用可用索引／头部／首个真实用户正文等回退，不自动追加适配后缀；合法同名主会话／用户分支不得按标题合并或删除。

## 3. 解析与固定快照

插件调用 `prepareSession({path,home,codexHome,keepTurns:30,historyMode:"truncate",toolOutputChars:8000,presentation:"audit",signal,...})`。Prepared保留固定source、最近N轮turns、stats、warnings和适配信息，不把更早历史收集到AI摘要路径；底层解析库的历史兼容选项不代表插件仍暴露摘要功能。

keepTurns 为整数 1–500，默认 30；toolOutputChars 为整数 256–64000，默认 8000。真实用户消息开轮；环境／运行时注入过滤或标明，混合消息中的真实用户正文保留。event_msg 镜像及 compacted replacement 不重复追加。缺失祖先前缀明确告警，不声称完整恢复；图片使用占位与告警，加密内容不解密。

固定源字节范围并计算SHA-256；后续追加不纳入快照，固定前缀改写／截短不得静默接受。逐行解析，近期轮次有界；超出N的历史只计数并跳过，不建立摘要缓存。工具输出首尾裁剪并标明省略量，不切坏参数JSON；未配对工具保留为历史说明。

## 4. 本地阅读适配与审计兼容

[adapt.js](<src/adapt.js>) 转换版本为 `readable-v2`。前端默认显式请求 readable；API 省略 presentation 时保持 audit 默认及原审计格式兼容。

阅读适配是本地确定性转换，不调用模型、不生成新的推理或结论。每会话安全说明及每轮历史工具摘要不可执行；运行时工具定义移入有界详情，普通代码／JSON 讨论不得误删。结构化 agent_message 转为中文不可执行协作说明，内部 ID／路由／脱敏结构只进有界详情，不把整段内部 JSON 塞入正文。

源中已有可读推理摘要仍保留于DSH原生reasoning区，不生成新的推理、不解密。该既有内容及本地工具摘要不等于AI摘要功能。readable-v2握手、转换版本和去重不变，不重写旧会话。

## 5. AI 摘要已停用

normalizeOptions默认truncate，仅该模式可用于新预览。显式summary或confirmSummary=true请求返回AI_SUMMARY_DISABLED，必须早于prepareSession和模型属性访问。

入口不注入llm／agentDefaultModel；Host不得访问deps.modelKey／generate，不调用summarizeChunks，不读写summary-cache。坏旧缓存不可阻断导入，旧数据不清理。

[summary.js](<src/summary.js>) 可保留历史纯函数和原PROMPT_VERSION常量以兼容去重身份；插件不存在可开启摘要的隐藏配置。去重键公式和readable-v2均保持，旧truncate命中原记录，旧summary项不与新truncate项混淆。

## 6. 服务、详情、写入与去重

[host.js](<src/host.js>) 提供 createService：scan、resetPreviews、preview、details、start、status、cancel、dispose。依赖为工作区注册表、官方Session v4和持久化；不依赖modelKey／generate或摘要缓存。

- resetPreviews只重置未提交预览及容量，不清去重manifest或旧缓存。前端携带batchId，选择／目标／参数变化需重新预览。
- 预览默认空闲TTL15分钟，最多24份、合计64MiB；超限拒绝，活动批次续租，不静默淘汰本批令牌。无需模型估算预留或摘要阶段。
- 界面不再提供“核查原始历史”操作。兼容 owner-only details API 以 previewId、offset、limit（最多 20）提供预览来源核查，重验固定前缀／SHA，返回有界只读页，不调用模型／写会话。importedId 仅兼容既有完整快照记录，版本不一致时区分 importedConversionVersion 与 parsedConversionVersion；新最小去重记录无来源快照，必须明确 SOURCE_UNAVAILABLE，不反向查找或猜测来源。
- start接收previewIds及必选targetWorkspaceId；拒绝缺失／过期预览。逐项顺序处理、错误隔离，取消保留完成项，失败不记成功。
- [events.js](<src/events.js>) 产生v4历史事件：一个空system头、递增序号／时间、唯一轮次及已结束assistant；历史工具不执行。新导入不追加AI生成的早期历史摘要，保留原始历史中已有的可读reasoning内容。
- 官方 Session.create 校验后依序持久化 create／append／flush／close，再 attachSession。绑定失败报告孤立制品标识，不未经核实自动删除。目录刷新失败不抹去已完成写入。

manifest 按源快照、选项／转换版本及目标去重，原有键计算不变，相同组合跳过、不覆盖。新项只存 hash → `{id}`，不写 sourceId、title、target、options、conversionVersion 或 sourceSnapshot。旧格式项保留原样并继续去重；scan 不返回导入清单或已导入标记。**不查询 DSH 归档／删除状态，也无强制重新导入功能**。目标删除后原记录仍可能阻止相同组合再次导入；manifest 保存失败必须警告重启后重复风险。

私有目录默认 .dsh/codex-recent-import/，当前来源配置与去重原子写入并请求目录0700／文件0600。旧摘要缓存保留但不读取或写入；不得因用户停用摘要擅自删除旧缓存或会话。不记录原始正文到错误日志，不新增评分或遥测。

## 7. RPC 与界面

[index.js](<index.js>) 使用宿主 Connection 共享 /api 的 owner-only 精确 POST 路由：sessions、resetPreviews、preview、details、jobs、status、cancel。保留 client-request／server-response 信封和请求关联；不另开未认证 loopback 服务，不替换共享鉴权。

[client.js](<client.js>) 使用宿主owner-only RPC，侧栏入口和三栏预览工作台不变。仅提供最近N轮、阅读／审计、工具预算与来源／目标选项；摘要策略、费用确认、摘要结果全部移除。target／source／capacity／快照与版本握手继续校验。

流程固定为 preview → start；打开页面不导入，仅活跃任务有界轮询。不提供导入历史列表、核查按钮、历史正文／调试JSON／常规处理说明或手动DSH目录刷新；当前批次进度、错误与自动目录刷新仍保留。

## 8. 开发验收与公开分发

现有 scripts 与包白名单见 [package.json](<package.json>)：

```sh
npm test
npm run check
npm run check:package
npm pack --ignore-scripts --dry-run
npm pack --ignore-scripts
```

普通合成测试覆盖最近N轮、截断、禁用旧AI摘要请求及零模型访问、旧缓存保持、取消、部分失败、去重、身份、协作适配、固定快照与owner RPC。历史纯summary库测试不代表插件提供模型能力。原生SDK／Session测试在安装与运行时条件满足才运行，否则明确skip；不据离线结果宣称真实GUI或Windows／WSL实机通过。

打包前核对文件白名单：无会话、缓存、真实样本、真实标题／标识或机器专用脚本。installer、proof 与历史 docs 留本地并由忽略规则排除，不是公开开发／运行依赖，不链接私有核验产物。截图仅用合成或充分脱敏样本。本契约不要求安装、真实模型调用、提交、推送或新增 CI。

本项目采用 [MIT](<LICENSE>)；保留 [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>) 的引用及第三方声明，DSH 宿主不随插件分发。
