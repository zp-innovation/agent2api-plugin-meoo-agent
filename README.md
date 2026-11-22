# agent2api-plugin-meoo-agent

[English](README.md) · [简体中文](README.zh-CN.md)

Bring [Meoo (秒悟)](https://meoo.com)'s **app-building Agent** into magpie as a provider.

## Why this exists

Meoo's Open API has **no chat completions endpoint**. It only understands three things:

```
create project  →  start an Agent Run  →  subscribe to an SSE event stream
```

Clients, on the other hand, speak the OpenAI protocol. Something has to translate.

Following magpie's plugin contract (the same approach
[`@magpie-community/opencode-commandcode-auth`](https://github.com/magpie-community/plugins) takes),
this plugin does the translation inside the **custom `fetch`** returned by `auth.loader()`:

- rewrites incoming `POST /chat/completions` into `POST /projects/{id}/agent/runs`
- reassembles `message.delta` / `message.snapshot` from the SSE stream back into a chat completion
- supports both streaming (`stream: true`) and non-streaming

**No port, no sidecar process** — the whole translation runs inside magpie.

## Install

Discovered on GitHub via the [`magpie-plugin`](https://github.com/topics/magpie-plugin) topic.
Inside magpie, open the **unofficial plugins (GitHub)** list and install it, or add it manually:

```bash
cd ~/.config/magpie/plugins
bun add github:zp-innovation/agent2api-plugin-meoo-agent
```

then add to `~/.config/magpie/plugins.json`:

```json
{ "spec": "agent2api-plugin-meoo-agent" }
```

**Provider id:** `meoo-agent`.

When adding an account, choose one of:

- **Browser sign-in (with API key, recommended)** — browser-based Meoo OAuth/PKCE login with a local loopback callback and automatic access-token refresh. You still enter a `meoo_ak_...` API Key because Agent Run endpoints need it; see "Browser sign-in (OAuth)" below.
- **API key** — create a `meoo_ak_...` key at [meoo.com](https://meoo.com) → 设置 → API 密钥.

### Using it with Agent2API

The same `index.mjs` is a valid **Agent2API script plugin** — the host contract is the
same shape (exported functions become provider entries; `auth.loader`, `auth.usage` and
`auth.methods[].authorize` are called as-is). Install it in the gateway's
**Plugins → Script plugins** with `github:zp-innovation/agent2api-plugin-meoo-agent` (or your own
fork); the provider id stays `meoo-agent`.

Once installed, the accounts page gains two real columns: **balance** (credit balance plus
per-grant due dates) and **expiry** (the plan period end). See the next section.

## Browser sign-in (OAuth)

On Agent2API script-plugin hosts that support dynamic login methods, **Add account** offers **Browser sign-in (with API key, recommended)**. It uses Meoo's OAuth Authorization Code + PKCE flow:

1. Enter a `meoo_ak_...` API Key; the plugin verifies it against the entitlement endpoint. The key is still required for `/open/v1/projects/{id}/agent/runs` — public protocol evidence shows no documented exchange from an OAuth access token / project service AK to a user API Key.
2. The plugin listens temporarily on `127.0.0.1` with a random port. The host opens `https://meoo.com/oauth/authorize`; after browser sign-in Meoo redirects back to the local `/oauth/callback`.
3. The host relays the callback URL to the plugin, which exchanges it for access/refresh tokens and reads identity and points. The host refreshes the access token before expiry and persists rotated refresh tokens.

**Daily login points** come from the browser login state itself; there is no separate check-in button. Browser sign-in counts as a login for that day, while the API-key method does not. The plugin does not and cannot claim a daily reward through an undocumented "check-in" endpoint (public probing found no such route). If you need the daily points, complete the browser sign-in once per day.

The original API-key method remains available.

## Speed tiers as model variants

Meoo's Run endpoint takes a `speed_tier` field (`fast` = lowest latency /
`standard` = balanced / `deep` = more reasoning, slower and costlier).
This plugin exposes it as **model variants**, so you pick it from the model dropdown
instead of configuring an environment variable:

```
qwen3.8-flash@fast        lowest latency
qwen3.8-flash@standard    balanced
qwen3.8-flash@deep        deepest reasoning
```

Every upstream model gets all three, so the model count is `upstream × 3`
(16 × 3 = **48** for the current Meoo catalogue).

The plugin strips the `@tier` suffix before calling Meoo, and keeps the full
variant name in the response's `model` field.

A model id without a suffix falls back to the default tier
(`fast`, overridable with `MEOO_SPEED_TIER`).

## Model capabilities (context window / max output)

The model list is genuinely synced: `models.refresh` reads
`GET /open/v1/projects/{id}/agent/capabilities`, which returns **only** `{id, name}` per
model — no context window, no max output, no modality flags. Every other candidate
endpoint (`/open/v1/models`, `/agent/models`, `/me`, `/usage`, `/credits`,
`/entitlement`, `/projects/{id}`, `/docs`) answers `404 not_found`, and the web SPA
ships no capability table either. So context/output **cannot be synced from Meoo**:
the plugin declares them.

Declared values (see `SPEC` / `SPEC_DEFAULT` in `index.mjs`):

| Model | Context | Max output |
| --- | --- | --- |
| `deepseek-v4-pro-0813` | 1 000 000 | 384 000 |
| everything else | 200 000 | 64 000 |

Lookups go through `specKey()`, which lowercases the id, drops the vendor prefix,
folds separators to `-` and strips a trailing 4-digit date stamp — so Meoo renaming
`DeepSeek/deepseek-v4.1-flash` to `deepseek-v4.1-flash-1017` keeps hitting the same
entry instead of collapsing to 0 (the original "上游未声明" bug).

Override without touching code, either

- by environment variable `MEOO_MODEL_SPECS`, a JSON object keyed by the raw id or the
  normalized one, e.g. `{"deepseek-v4.1-flash-1017":{"context":1000000,"output":128000}}`, or
- in the panel's **模型能力** dialog, which writes a per-model override layer that wins
  over the plugin's declaration.

`supportsToolCall` / `supportsImages` / `supportsVideo` / `supportsReasoning` stay
`false` on purpose: the Run payload only carries `{message, model, speed_tier}`, the
SSE stream has no reasoning channel, and `flatten()` downgrades multimodal content to
`[image_url]` text. Marking them `true` would make downstream clients send images and
tools that Meoo silently drops.

## Environment variables

All optional. Read when the plugin loads, i.e. **before magpie starts**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | **Fallback only** — used when a model id carries no `@tier` |
| `MEOO_MODEL_SPECS` | — | JSON overrides for the context/output spec table (raw or normalized model ids) |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Meoo project the Agent works in; reused when it already exists |
| `MEOO_TIMEOUT_MS` | `600000` | Per-Run timeout in milliseconds |
| `MEOO_AUTO_ANSWER` | see source | Auto-reply when the Agent asks a question. Empty string = fail instead of auto-answering |
| `MEOO_VERBOSE` | off | `1` turns on plugin logging |

## Balance and expiry (credits)

Meoo's Open API has no billing endpoint — `/open/v1/account`, `/balance`,
`/credits`, `/usage`, `/plans` are all 404. The real numbers live on the web
control plane, and an API key may only reach it when it identifies itself as the CLI:

```
GET https://meoo.com/api/mc/entitlement/get
Authorization: Bearer meoo_ak_...
X-Meoo-Client: cli
```

Without `X-Meoo-Client: cli` every `/api/mc/*` and `/api/v1/*` call returns
`401 API_KEY_CLIENT_REQUIRED`. `X-Client-Type`, `X-Meoo-Client: meoo-cli` and
`User-Agent: meoo-cli/...` are **not** accepted (empirically). The header does not
disturb `/open/v1`, so the plugin sends it everywhere.

Two hooks use that endpoint:

- **`auth.methods[0].authorize`** — at login the key is verified against
  `entitlement/get`, the identity is read from `/api/v1/user/me`, and the earliest
  real expiry (`activeGrants[].grantDetails[].expiresDate`, falling back to
  `currentPeriodEnd`) is stored in the account as **both `expires` and `expiresAt`**.
  The account name is rewritten to the Meoo display name on every usage query.
- **`auth.usage`** — reports the credit balance so the gateway renders a real
  balance cell instead of "—".

What the panel shows:

| Field | Source | Rendered as |
| --- | --- | --- |
| 积分余额 | `userPointInfo.account.availableBalance` / `totalGranted` | window `剩 8137 / 9000 积分` + meter |
| 逐份到期 | `userPointInfo.activeGrants[].grantDetails[]` | one `积分到期` window per grant, e.g. `登录赠送积分 · 11-26 到期` |
| 套餐 | `data.planName` | plan badge (`Free 免费版` → 免费版) |
| 有效期 | `expiresAt` in the account record | `N 天后` |

Notes and hard-won constraints:

1. `activatedEndTime` is `9999-12-31` for the free plan — it must never be used as
   the expiry.
2. Per-grant rows carry `aside: true`, so the gateway's pre-flight allowance check
   (which turns `remainingPercent === 0` or `balance === 0` into a `429`) ignores
   them. The main window must report the **real** balance: reporting `0` there would
   block forwarding.
3. The host's `reports.mjs` copies `row.name` into both `label` and `window`, and
   the drill-down only renders `resetsAt` — that is why the due date is embedded in
   the window name (`· MM-DD 到期`) and `resetsAt` is set to the grant's expiry.
4. `credit_detail` stays `false`: the per-pack `credits[]` array is produced by the
   Rust providers only, script plugins cannot fill it.
5. `long_lived` is hard-coded to `false` for every remote provider by the host's
   `models.mjs`, so the account is never labelled "长期有效" — it shows the real date.
6. Meoo's timestamps are naive Beijing-time strings (`2026-12-19T00:00:00`). The plugin
   appends `+08:00` before parsing, because the gateway runs in a UTC container and a
   plain `Date.parse` would shift every due date by eight hours (and push
   `23:59:59` grants into the next day). Labels use the same offset, so
   `· 11-26 到期` and the drill-down reset time always agree.

## Known limitations

1. **It is not a model — it is an app-building Agent.** It carries project context,
   calls tools, and writes files into that Meoo project. It will usually answer a
   general question fine, but it is not a general-purpose LLM.
2. **Slow.** One Run takes minutes (`deep` longer). Ordinary chat clients may time out.
3. **Billed in credits, not tokens.** The real cost is `usage.meoo_credits_used`;
   `prompt_tokens` / `completion_tokens` are always 0 because Meoo's protocol
   does not report them.
4. **No `temperature` / `max_tokens` / `tools` / function calling.** Meoo's protocol
   has no such fields, they are silently ignored — hence `tool_call` is reported as `false`.
5. **No multi-turn conversation mapping.** Each request is an independent Run.
6. **Streaming may occasionally drop a fragment.** `message.snapshot` has been observed
   arriving out of sync with the accumulated deltas; the plugin skips that frame's
   increment (non-streaming is unaffected — the final text follows the snapshot).
   Use `stream: false` if you want to be safe.

## Authorization note

Meoo's own documentation states that a user API key "must not be used as a way to
bypass team system integration or the integration-tier entitlement package".
This plugin is a personal-use adapter. Please do not run it as a service for others.

## License

MIT
