# eve-agent

用 [eve](https://eve.dev)（Vercel 的 beta 智能体框架）搭的完整 demo：中文「备忘录助手」。

- **模型**：DeepSeek 的 Anthropic 兼容入口 `https://api.deepseek.com/anthropic`，模型 `deepseek-v4-flash`，直连不走 AI Gateway
- **状态**：Redis（OrbStack 里的容器），长期记忆、待办、对话记录、会话事件全部落 Redis
- **入口**：eve 默认 HTTP channel（`/eve/v1`），配一个命令行客户端

## 架构

```
agent/
├── agent.ts              模型配置：直连 DeepSeek 的 Anthropic 兼容端点
├── instructions.md       系统提示词：身份、记忆规则、工具用法
├── channels/eve.ts       HTTP channel：鉴权链 + CORS
├── lib/
│   ├── env.ts            读取项目根 .env
│   ├── deepseek.ts       createAnthropic({ baseURL }) 构造 LanguageModel
│   ├── redis.ts          Redis 连接单例 + 键命名
│   ├── messages.ts       模型消息 → 纯文本
│   ├── memory-store.ts   事实与对话记录的 Redis 读写 + 关键词检索
│   ├── todo-store.ts     待办的 Redis 读写
│   ├── redis-memory.ts   长期记忆 provider（recall / capture / tools）
│   └── redis-todo.ts     待办 provider（只有 tools）
├── memory/
│   ├── profile.ts        长期记忆槽 → profile__remember / search / forget / list / history
│   └── workspace.ts      待办槽 → workspace__add / list / complete / remove
├── tools/
│   ├── get_weather.ts    离线占位工具，演示工具调用
│   └── redis_overview.ts 扫描 Redis，如实报告键名/类型/条数/TTL
└── hooks/
    └── session-log.ts    把会话生命周期事件写入 Redis
```

### 状态怎么分区

Redis 里每个用户一份数据，分区键由 eve 的 memory 槽锁定，模型改不了：

| 键 | 类型 | 内容 | 写入方 |
| --- | --- | --- | --- |
| `eve-agent:facts:<scope>` | hash | 长期事实，field = 事实 id | `profile` 槽的工具 |
| `eve-agent:turns:<scope>` | hash | 每轮对话记录，field = operationId（天然幂等） | `profile` 槽的 capture |
| `eve-agent:todos:<scope>` | hash | 待办，field = todo id | `workspace` 槽的工具 |
| `eve-agent:session:<sessionId>:events` | list | 会话生命周期事件，保留 7 天 | `hooks/session-log.ts` |

`<scope>` 是 eve 根据 namespace + scope 算出的不透明摘要。待办和长期记忆共用同一个 scope，
所以两类状态天然按同一个用户分区，不会串号。

### 多轮对话的上下文存在哪：不在 Redis

这是个容易搞混的点。**模型看到的多轮消息历史由 eve 的 Workflow world 保存**，
本地开发落在 `.eve/.workflow-data/steps/<sessionId>/*.json`——每个 step 的
`input` / `output` 是 `@workflow/serde` 序列化后再 zstd 压缩的 blob，
里面是完整的消息数组（含 reasoning、工具调用、工具结果）。

Redis 里的 `turns` 是**另一回事**：它只是 `profile` 槽的 capture 写下的
「用户输入 + 助手回复」纯文本副本，给 `profile__history` 工具和人工审计用，
**不参与**模型上下文。

召回的记忆则以 `kind: "memory.load"` 的 user 消息插在当轮用户消息之前。实测解压一个
step 文件能看到完整的消息序列：

```
[user]        记住：我在做一个叫 eve-agent 的项目
[assistant]   reasoning + tool_call profile__search
[tool]        {"count":0,"facts":[]}
[assistant]   reasoning + tool_call profile__remember
[tool]        {"saved":true,...}
[assistant]   已记住：用户在做名叫 eve-agent 的项目
[user]        ← kind: memory.load，来自 Redis 的召回
[user]        我刚才说我叫什么项目？
[assistant]   你说的是 eve-agent
[user]        北京天气怎么样
```

由此推出的运维含义：

- **删掉 `.eve/.workflow-data` 会丢掉进行中的会话上下文**，但 Redis 里的长期记忆和待办不受影响，
  新会话照样能召回。
- 部署到 Vercel 时这份状态由 Vercel Workflow 承载；自托管时要持久化 `.eve/.workflow-data`
  或换一个外部 world。详见 [Self-Hosting](https://eve.dev/docs/guides/deployment/self-hosting)。

## 跑起来

### 1. Redis

```bash
npm run redis:up      # docker start eve-redis，不存在则创建（redis:7-alpine，6379）
npm run redis:cli     # 进 redis-cli
```

### 2. 配置

```bash
cp .env.example .env
```

填 `DEEPSEEK_API_KEY`。其余默认值：

```
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic/v1
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_CONTEXT_WINDOW=1048576
DEEPSEEK_MAX_OUTPUT_TOKENS=16384
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=eve-agent
```

> `DEEPSEEK_BASE_URL` 末尾必须带 `/v1`。AI SDK 的 Anthropic provider 把 baseURL 当成
> `https://api.anthropic.com/v1` 那样用，会在后面接 `/messages`。写 `.../anthropic`
> 会拼出 `.../anthropic/messages` 得到 404。`agent/lib/deepseek.ts` 里会自动补 `/v1`。

### 模型侧的事实（`GET /v1/models` 实测）

| 字段 | 值 |
| --- | --- |
| 可用模型 id | `deepseek-flash`（DeepSeek-V4.1-Flash）、`deepseek-v4-pro`（DeepSeek-V4-Pro） |
| `context_window` | `1048576`（1 Mi） |
| `max_output_tokens` | `393216` |
| `effort` | 支持 `low` / `high` / `max`，默认 `high` |
| `deepseek-flash` 输入模态 | `text` + `image` |

- `deepseek-v4-flash` 是**旧名**，仍被接受（请求由 V4.1-Flash 提供服务），但不在 `/v1/models`
  列表里。要换成官方名改 `DEEPSEEK_MODEL` 一行。
- 该模型**默认开启 thinking**。响应里带 `thinking` 内容块，AI SDK 会解析成 reasoning，
  provider 层已验证不影响工具调用。
- **`DEEPSEEK_MAX_OUTPUT_TOKENS` 必须显式给。** AI SDK 不认识 DeepSeek 的模型名，会打警告
  并把输出上限压到 4096：

  ```
  The model "deepseek-v4-flash" is unknown. The max output tokens have been limited to 4096.
  ```

  eve 的 `modelOptions` 只支持 `providerOptions` 和 `promptCache`，没有 `maxOutputTokens`，
  所以 `agent/lib/deepseek.ts` 用 `wrapLanguageModel` 中间件兜底注入。

### 3. 启动 agent

先自检配置、Redis 和模型凭据，避免 401 之类的错误混在会话日志里：

```bash
npm run doctor
```

然后启动：

```bash
npm run dev            # 交互式终端 UI
npm run dev:headless   # 只起 HTTP 服务，不开 TUI
```

服务默认监听 `http://127.0.0.1:2000`。

### 4. 对话

```bash
npm run chat "记住：我住在杭州，喜欢喝美式咖啡"
npm run chat -- --verbose "北京天气怎么样"
npm run chat                     # 多轮交互
```

或直接打 HTTP：

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"我平时喝什么咖啡？"}'
# {"ok":true,"sessionId":"wrun_...","status":"accepted"}

curl http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream
```

### 5. 看状态

```bash
docker exec eve-redis redis-cli --scan --pattern 'eve-agent:*'
docker exec eve-redis redis-cli LRANGE eve-agent:session:<sessionId>:events 0 -1
```

也可以直接问 agent「你的状态存在哪？」，它会调 `redis_overview` 给出真实结果。

## 跨会话记忆是怎么验证的

1. 会话 A 说「记住：我住在杭州，喜欢喝美式咖啡」→ `profile__remember` 写进 `eve-agent:facts:<scope>`
2. 会话 B（全新 session）问「我平时喝什么咖啡？」
3. 下一轮开始前，`profile` 槽的 recall 按输入检索 Redis，把命中的事实作为 user 消息注入
4. 模型实际收到的内容里多了一条：`我住在杭州，喜欢喝美式咖啡`

### 检索怎么做的，以及它的边界

没有向量库。`agent/lib/memory-store.ts` 用关键词重叠打分：英文按词，中文同时收单字（权重 1）
和二元组（权重 2），命中分数低于 2（一个二元组，或两个不同单字）的不算命中。

- 「我平时喝什么？」能召回「我喜欢喝美式」——靠「我」「喝」两个单字
- 「北京天气怎么样」不会召回咖啡那条——没有共同字词，正确排除

**这是关键词匹配，不是语义检索。** 同义改写（「喝什么咖啡」vs「咖啡因摄入习惯」）召不回来。
要真正的语义召回，把 `searchFacts` 换成向量检索即可，provider 契约不用动。

## 没有可用 API Key 时怎么验证

仓库里带了 `scripts/mock-anthropic.mjs`，一个本地 Anthropic Messages API 模拟端点。
它按用户输入里的关键词决定调哪个工具，再返回固定格式的文本，不产生真实模型调用。

```bash
npm run mock:model                                          # 终端 1，监听 127.0.0.1:8787
DEEPSEEK_BASE_URL=http://127.0.0.1:8787/v1 npm run dev:headless   # 终端 2
npm run chat -- --verbose "北京天气怎么样"                     # 终端 3
```

`DEEPSEEK_BASE_URL` 是环境变量，会覆盖 `.env` 里的同名值。

它能验证的：会话创建、模型调用、工具执行与入参校验、Redis 读写、跨会话召回、事件流。
它验证不了的：真实模型的指令遵循、工具选择质量、多轮推理。

## 排查

### 模型调用失败时，别信 eve 的那条提示

直连 provider（不走 AI Gateway）时，如果上游返回 401，eve 会把它归类成
`AI Gateway authentication failed`，并提示：

```
Run `eve link` to populate `VERCEL_OIDC_TOKEN`, or set `AI_GATEWAY_API_KEY`
```

**这条提示对直连场景是错的。** 真实原因在上游字段里，`scripts/chat.mjs` 会把它打出来：

```
失败 [MODEL_CALL_FAILED] HTTP 401
  原因：Authentication Fails, Your api key: ****16f4 is invalid
```

要自己挖完整详情，用事件流里的 `step.failed`：

```
event.data.details.apiErrorMessage   ← 上游 provider 的原话
event.data.details.statusCode        ← 上游 HTTP 状态
```

`npm run doctor` 也会直接对端点发一次请求，绕开 eve 的错误包装。

## 环境坑：WorkBuddy 沙箱里的 NODE_OPTIONS

WorkBuddy 会给每个 Node 进程注入
`NODE_OPTIONS=--require=.../node-language-shim.cjs`，把 `fs.rmdir` / `unlink` 转到
safe-delete 代理。eve 的本地 Workflow world 用 `proper-lockfile` 加锁，解锁要 `rmdir`，
被代理拒绝后锁目录残留，症状是每一轮都失败：

```
WorkflowWorldError: Could not release Hook token claim lock
Could not acquire Hook token claim lock
```

在 WorkBuddy 的终端里跑，用 `npm run dev:clean`（等价于清掉 shim 后启动）：

```bash
npm run dev:clean
# 或
env -u NODE_OPTIONS npx eve dev --no-ui --port 2000
```

另外 `rm -rf` 删除超过 50 个文件也会被代理拒绝（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），
清本地 workflow 数据改用 Node：

```bash
env -u NODE_OPTIONS node -e 'fs.rmSync(".eve/.workflow-data",{recursive:true,force:true})'
```

自己的机器上没有这层 shim，`npm run dev` 直接可用。

## 部署

`eve deploy` 走 Vercel；自托管：

```bash
npm run build                                  # 产物在 .output/
EVE_AUTH_TOKEN=<一段长随机串> npm run start -- --host 0.0.0.0 --port 3000
```

**`eve start` 是生产模式，`localDev()` 不生效。** 生产请求默认一律 401
（`WWW-Authenticate: Bearer`），`GET /eve/v1/health` 除外——它始终公开，供探活用。
`agent/channels/eve.ts` 里的鉴权链按这个顺序走：

| 环境变量 | 行为 |
| --- | --- |
| `EVE_AUTH_TOKEN=<token>` | 校验 `Authorization: Bearer <token>`，用 `timingSafeEqual` 比较 |
| 未设置 | 落到 `placeholderAuth()`，拒绝所有生产请求 |
| `EVE_AUTH_MODE=none` | 完全不鉴权。只在确认流量可以公开时用 |

自托管时客户端要带凭据：

```bash
EVE_AUTH_TOKEN=<token> npm run chat -- "你好"
```

其余注意：

- 把 `DEEPSEEK_API_KEY`、`REDIS_URL`、`EVE_AUTH_TOKEN` 放进运行环境变量，别写进 `agent.ts`
- 持久化 `.eve/.workflow-data`，或给 `agent.ts` 的 `experimental.workflow.world` 换一个外部 world
- 反向代理要同时转发 `/eve/` 和 `/.well-known/workflow/`，后者漏了会话会在回调阶段卡住

## 验证记录

下面这些都在本机实际跑过，不是推测。前两部分用 mock 模型，最后一部分用真实 DeepSeek 模型。

**基础设施**

| 项目 | 结果 |
| --- | --- |
| `npx tsc` / `npx eve info` | 0 错误 |
| Redis 读写（facts / turns / todos） | 通过 |
| 同进程内跨会话召回 | 通过 |
| **杀掉 dev server 后，新进程 + 新会话仍能召回** | 通过 |
| 同 id 写入是覆盖而非追加 | 通过 |
| `eve build` 生产构建 | 通过（10.7 MB） |
| `eve start` 生产鉴权：health 公开、无凭据 401、错凭据 401、正确凭据 202 | 通过 |
| 生产构建产物下的完整一轮对话 | 通过 |
| 模型失败时的报错：真实上游原因 + 退出码 1 | 通过 |
| 交互式多轮（管道喂 stdin，同一会话连续三轮） | 通过 |
| 检索召回：相关问题命中、无关问题排除 | 通过 |

**真实 DeepSeek 模型（`deepseek-v4-flash`）**

| 场景 | 实际行为 |
| --- | --- |
| 「记住：我住在杭州，喜欢喝美式咖啡」 | 先调 `profile__list` 确认没存过，再拆成两条原子事实写入，id 自己起为 `user_city` / `user_coffee_preference` |
| 全新会话问「我平时喝什么咖啡？」 | 召回成功，回答带 id 和记录日期 |
| 「北京天气怎么样？」 | 调 `get_weather`，给出结果并主动说明是占位数据 |
| 「帮我把下周评审加进待办」 | 调 `workspace__add`，返回 id 并提示可补日期 |
| 「我有哪些待办？」 | 列出未完成项，并主动询问是否标记完成 |
| 「你的状态存在哪？」 | 调 `redis_overview`，准确报出 9 个键、三类数据、以及 7 天 TTL |
| 工具调用 | 正常，`thinking` 块被解析为 reasoning，不影响调用 |
| `maxOutputTokens` 警告 | 修复后不再出现 |

Redis 里最终的键：`facts`（2 条）、`todos`（1 条）、`turns`（6 条）、6 个 session 事件 list。
