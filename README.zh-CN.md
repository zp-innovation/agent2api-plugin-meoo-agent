# magpie-plugin-meoo-agent

[English](README.md) · [简体中文](README.zh-CN.md)

把 [Meoo（秒悟）](https://meoo.com) 的**建站 Agent** 接成 magpie 的一个 provider。

## 为什么需要这个插件

Meoo 的 Open API **没有 chat completions**。它只有三个概念：

```
建项目  →  起一次 Agent Run  →  订阅 SSE 事件流
```

而客户端说的是 OpenAI 协议。所以中间必须有个翻译层。

这个插件按 magpie 的插件契约（与
[`@magpie-community/opencode-commandcode-auth`](https://github.com/magpie-community/plugins) 同样的做法），
在 `auth.loader()` 返回对象的**自定义 `fetch`** 里做翻译：

- 把 magpie 发来的 `POST /chat/completions` 改写成 `POST /projects/{id}/agent/runs`
- 把 SSE 里的 `message.delta` / `message.snapshot` 拼回 chat completion
- 流式（`stream: true`）和非流式都支持

**不占端口、不起独立进程**，整个翻译跑在 magpie 进程内。

## 安装

通过 GitHub 的 [`magpie-plugin`](https://github.com/topics/magpie-plugin) 标签被发现。
在 magpie 里打开**非官方插件（GitHub）**列表安装，或手动加：

```bash
cd ~/.config/magpie/plugins
bun add github:RexVane/magpie-plugin-meoo-agent
```

然后在 `~/.config/magpie/plugins.json` 里加：

```json
{ "spec": "magpie-plugin-meoo-agent" }
```

**Provider id：** `meoo-agent` · **认证方式：** `API key` —— 在
[meoo.com](https://meoo.com) → 设置 → API 密钥 建一把 `meoo_ak_...`。

### 在 Agent2API 里用

同一个 `index.mjs` 也是合法的 **Agent2API 脚本插件**（宿主契约一致：导出函数会被当作
provider 入口，`auth.loader` / `auth.usage` / `auth.methods[].authorize` 都按原样调用）。
在网关的「插件 → 脚本插件」里用 `github:RexVane/magpie-plugin-meoo-agent`（或你自己的 fork）
安装即可，安装后 provider id 仍是 `meoo-agent`。

装好后账号页会多出两列真实读数：「余额」显示积分余额与逐份到期，「有效期」显示套餐周期到期日
（见下节）。

## 档位：做成模型变体

Meoo 的起 Run 接口有个 `speed_tier` 字段（`fast` 优先低延迟 /
`standard` 平衡 / `deep` 更多推理但更慢更费）。
本插件把它**做成模型变体**，从模型下拉框里直接选，不用配环境变量：

```
qwen3.8-flash@fast        快速
qwen3.8-flash@standard    标准
qwen3.8-flash@deep        深度
```

每个上游模型都有这三个变体，所以模型数 = 上游模型数 × 3（实测 14 × 3 = **42 个**）。

插件在起 Run 前会把 `@档位` 后缀剥掉再发给 Meoo，响应里的 `model` 字段仍保留完整变体名。

没带 `@档位` 的模型 ID 走兜底档（默认 `fast`，可用 `MEOO_SPEED_TIER` 覆盖）。

## 环境变量

都是可选的，在**启动 magpie 之前**设好（插件加载时读取）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | **仅兜底** —— 模型 ID 没带 `@档位` 时才用 |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Agent 工作所在的项目名，同名复用不重复创建 |
| `MEOO_TIMEOUT_MS` | `600000` | 单次 Run 超时（毫秒） |
| `MEOO_AUTO_ANSWER` | 见源码 | Agent 反问时的自动回答。设为空字符串则不自动回答，直接报错 |
| `MEOO_VERBOSE` | 关 | `1` 打开插件日志，排查用 |

## 余额与有效期（积分）

Meoo 的 Open API 没有账单端点 —— `/open/v1/account`、`/balance`、`/credits`、
`/usage`、`/plans` 全部 404。真实的数字在网页控制面上，而 API Key 只有在自称 CLI
时才能访问它：

```
GET https://meoo.com/api/mc/entitlement/get
Authorization: Bearer meoo_ak_...
X-Meoo-Client: cli
```

不带 `X-Meoo-Client: cli` 时所有 `/api/mc/*` 与 `/api/v1/*` 都返回
`401 API_KEY_CLIENT_REQUIRED`；`X-Client-Type`、`X-Meoo-Client: meoo-cli`、
`User-Agent: meoo-cli/...` 都不行（实测）。这个头不影响 `/open/v1`，所以插件全局都带。

插件用两个钩子吃这个接口：

- **`auth.methods[0].authorize`** —— 登录时先用 `entitlement/get` 校验这把 key，
  再从 `/api/v1/user/me` 拿身份，把最早的**真实**到期时刻
  （`activeGrants[].grantDetails[].expiresDate`，取不到就退回 `currentPeriodEnd`）
  以 **`expires` 与 `expiresAt` 两个键**写进账号；每次查余额还会把账号名刷成 Meoo 的显示名。
- **`auth.usage`** —— 上报积分余额，让网关把「余额」列从「—」变成真读数。

界面上看到的东西：

| 字段 | 来源 | 显示成 |
| --- | --- | --- |
| 积分余额 | `userPointInfo.account.availableBalance` / `totalGranted` | 窗口 `剩 8137 / 9000 积分` + 进度条 |
| 逐份到期 | `userPointInfo.activeGrants[].grantDetails[]` | 每份一条 `积分到期` 窗口，如 `登录赠送积分 · 11-26 到期` |
| 套餐 | `data.planName` | 套餐徽章（`Free 免费版` → 免费版） |
| 有效期 | 账号记录里的 `expiresAt` | `N 天后` |

几条踩出来的硬约束：

1. 免费版的 `activatedEndTime` 是 `9999-12-31`，**绝不能**拿来当有效期。
2. 逐份到期行带 `aside: true`，网关转发前的额度预判（`remainingPercent === 0` 或
   `balance === 0` 就 `429`）会跳过它们；主窗口必须报**真实**余额 —— 那里报 0 会直接
   把转发拦掉。
3. 宿主的 `reports.mjs` 把 `row.name` 同时当成 `label` 与 `window`，而弹层只渲染
   `resetsAt`，所以到期日只能塞进窗口名（`· MM-DD 到期`），并把 `resetsAt` 设成该份的到期时刻。
4. `credit_detail` 仍是 `false`：逐份明细用的 `credits[]` 只有 Rust provider 能产出，
   脚本插件通道拿不到。
5. `long_lived` 被宿主的 `models.mjs` 对所有远端 provider 写死为 `false`，所以账号不会
   被标成「长期有效」，而是显示真实日期。

## 已知限制

1. **它不是模型，是「建站 Agent」。** 带着项目上下文、会调工具、会往 Meoo 那个项目里写文件。
   问它通用问题通常也能正常作答，但它本质不是通用 LLM。
2. **慢。** 一次 Run 是分钟级（`deep` 档更久），普通聊天客户端容易超时。
3. **按积分计费，不是 token。** 真实消耗看 `usage.meoo_credits_used`；
   `prompt_tokens` / `completion_tokens` 恒为 0，因为 Meoo 协议不返回这些。
4. **没有 `temperature` / `max_tokens` / `tools` / 函数调用。** Meoo 协议里没有这些字段，
   传了会被静默忽略，所以本插件如实把 `tool_call` 标成 `false`。
5. **没有多轮会话映射。** 每次请求是独立的一次 Run。
6. **流式下偶尔会缺片段。** Meoo 的 `message.snapshot` 实测出现过与已累积 delta 对不上的情况，
   插件会跳过那一帧的增量（非流式调用不受影响，最终全文以 snapshot 为准）。
   想稳就用 `stream: false`。

## 授权提醒

Meoo 官方文档写明：用户 API Key「不能作为绕过团队系统集成和集成版权益套餐的方式」。
本插件是个人自用性质的适配层，请勿拿它对外提供服务。

## License

MIT
