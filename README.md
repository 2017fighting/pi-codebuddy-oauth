# pi-codebuddy-oauth

[![npm version](https://img.shields.io/npm/v/pi-codebuddy-oauth.svg)](https://www.npmjs.com/package/pi-codebuddy-oauth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [CodeBuddy](https://www.codebuddy.cn)（腾讯 IOA 编程助手）提供 [Pi](https://github.com/earendil-works/pi) 扩展，把 CodeBuddy 作为 **OpenAI 兼容 HTTP provider** 接入 Pi。

与 [pi-codebuddy-sdk](https://github.com/RealAlexandreAI/pi-codebuddy-sdk)（spawn `codebuddy` CLI 子进程 + MCP bridge）不同，本扩展走**轻量 HTTP 直连**（`/v2/chat/completions`）：协议栈复用 pi-ai 内置 `openai-completions`，扩展只负责鉴权、模型发现、动态头注入与瞬时故障重试。无 CLI 依赖、无子进程、无会话文件管理。

## 特性

- **OAuth 登录** — Pi 原生 `/login` 流程接入 IOA：`/v2/plugin/auth/state` → 浏览器 → 轮询 token。token 刷新由 Pi 双检锁托管（5 分钟 skew 预刷新）。
- **API Key 登录** — 设置 `CODEBUDDY_API_KEY`（`ck_xxx`）即可，无需浏览器。
- **自动模型发现** — 调用 `GET /v3/config` 提取 craft agent 模型列表（5 分钟 TTL 缓存 + 单飞；登录后自动触发）。
- **401/403 中途刷新重试** — 流式请求中 token 失效时自动刷新并重试一次（15 秒冷却防抖）。
- **瞬时 400（code 11133）自动重试** — CodeBuddy 网关偶发把上游瞬时校验失败包装成 HTTP 400 `{"code":11133}` 返回；拦截器按 **1s → 4s → 10s → 25s** 退避幂等重发（最多 4 次，总等待 ≤40s），其他 400 原样透传。
- **session 级 `X-Conversation-ID` 稳定化** — 同一 Pi session 复用同一 conversation id，提升上游 prompt cache 命中率（compaction 时淘汰）。
- **双 provider 常驻：国内 + 国际** — 同一扩展注册 `codebuddy`（国内 `copilot.tencent.com`）与 `codebuddy-intl`（国际 `www.codebuddy.ai`）两个 provider，各自独立登录/凭据/模型发现，无需重启切网。原 `CODEBUDDY_NETWORK` 废弃。两个模型家族可在 pi-multiprovider 的 `/vprovider` 里组成虚拟 provider 轮询/故障切换。
- **凭据唯一事实源 = Pi auth.json** — token 每流由 Pi host 解析（过期带锁预刷新）并注入 Authorization 头，扩展不再维护本地 token 快照（原 `~/.pi/agent/codebuddy-auth.json` 废弃，可手动删除）。

## 安装

```bash
pi install npm:pi-codebuddy-oauth
```

或本地路径开发调试：

```bash
pi install /path/to/pi-codebuddy-oauth
```

重启 `pi`，然后 `/model` → 选 `codebuddy/...`。

## 登录

两个 provider 各自独立登录（凭据按 provider id 存在 Pi 的 auth.json）：

```
/login codebuddy          # 国内（IOA）
/login codebuddy-intl     # 国际
```

按提示在浏览器完成登录，token 自动持久化。也可分别用 API Key：

```bash
export CODEBUDDY_API_KEY=ck_xxx        # 国内
export CODEBUDDY_INTL_API_KEY=ck_xxx   # 国际
```

## 环境变量

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 国内 provider 完整 base URL 覆盖，优先级最高 |
| `CODEBUDDY_AUTH` | `auto` | `auto` / `oauth` / `api` |
| `CODEBUDDY_API_KEY` | _(空)_ | API Key（`ck_xxx`），`auto` 模式下隐含启用 API Key 模式 |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求 model（写进 `X-Model-ID`） |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | `0` 关闭 session 级 conversation-id 稳定化 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 容量 |
| `CODEBUDDY_TENANT_ID` / `CODEBUDDY_ENTERPRISE_ID` / `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖自动提取的身份头（仅 OAuth 模式） |

国际 provider（`codebuddy-intl`）环境变量完全镜像，前缀换成 `CODEBUDDY_INTL_`：`CODEBUDDY_INTL_ENDPOINT`、`CODEBUDDY_INTL_AUTH`、`CODEBUDDY_INTL_API_KEY`、`CODEBUDDY_INTL_MODEL`、…（默认端点 `https://www.codebuddy.ai`）。

> **迁移**：原 `CODEBUDDY_NETWORK=internet` 用户请改用 `codebuddy-intl` provider（需重新 `/login codebuddy-intl`，凭据按 provider id 隔离）；国内用户无感知。`CODEBUDDY_NETWORK` 与 `~/.pi/agent/codebuddy-auth.json` 均已废弃，可删除。

## 架构

每个 provider 实例（`codebuddy` / `codebuddy-intl`）各一套：

```
Pi agent
  │ modelRuntime.streamSimple（auth 解析 / 凭据刷新）
  ▼
streamSimple wrapper（src/stream.ts）
  │ 注入 22 头（X-Conversation-ID 稳定化 / B3 / X-Model-ID …）
  │ 注入自定义 fetch
  ▼
auth-fetch 拦截器（src/auth-fetch.ts）
  │ 从 host 注入的 Authorization 解析 token（JWT → oauth / 其他 → api / 占位 → 401 指引）
  │ 认证头注入（oauth: Bearer + 租户身份头 / api: Bearer + X-API-Key）
  │ 首 token 触发懒模型发现
  │ 400+11133 → 1s/4s/10s/25s 幂等重发
  ▼
${server}/v2/chat/completions   （协议栈：pi-ai openai-completions）
```

凭据唯一事实源是 Pi 的 `auth.json`（按 provider id 各存一份）：host 每流解析 token、过期时带锁预刷新（`oauth.refreshToken`，5 分钟 skew），经 `options.apiKey` 注入 Authorization 头。流中途 token 失效时错误直接透传，Pi 在下一流前自动刷新自愈；扩展不维护任何本地 token 副本。

| 模块 | 来源 |
| ---- | ---- |
| `auth-flow.ts` / `auth-state.ts` / `jwt.ts` / `headers.ts` / `lru.ts` / `fetch-json.ts` | 平移自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) |
| `models.ts` | 平移 + 转换为 Pi `ProviderModelConfig` |
| `auth-fetch.ts` | 平移改造：删 SSE 缓冲、预刷新与本地快照（token 改由 host 每流注入） |
| `auth-state.ts` | 重写：从请求头解析鉴权（原为快照读取） |
| `index.ts` / `stream.ts` | 新写：Pi extension 接线；双 provider 工厂 |
| `model-cache.ts` | 新写：持久化模型列表，消除启动期发现竞态（见下） |

### 模型列表缓存

模型发现（`GET /v3/config`）是异步的，而会话恢复走同步路径。若会话在发现返回前恢复，
`codebuddy/<具体模型>` 尚未注册，pi 会报
`Warning: Could not restore model codebuddy/xxx (model no longer exists)` 并回落到 `auto`。

为此，扩展把上次成功发现的模型落盘到 `~/.pi/agent/<providerId>-models-cache.json`
（`codebuddy-models-cache.json` / `codebuddy-intl-models-cache.json`），
启动时先同步以缓存为种子注册，再等网络发现刷新缓存（登录后立即触发；运行期首个携带 token 的
请求懒触发）。缓存只影响「首个可见模型集合」的时机，不替代网络发现：发现失败时仍回落到已缓存列表或 `auto`。

刻意不写入 `models.json`：codebuddy 是扩展注册的 provider，鉴权由 `auth-fetch` 拦截器注入
（自定义 `streamSimple`）。在 `models.json` 声明同 id 的原生 provider 会产生 baseUrl/api
双重定义并绕过拦截器，也会与 pi-model-manager 的跨进程锁相互干扰。

## 开发

```bash
npm install
npm test        # vitest
npm run typecheck
```

## 许可证

[MIT](./LICENSE) — © 2026 SoulChildTc；部分代码源自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) © 2026 Ming Lo (MIT)
