// src/index.ts — Pi 扩展入口：注册 codebuddy（国内）+ codebuddy-intl（国际）两个 provider
// （HTTP 直连 /v2/chat/completions）
//
// 数据流（每个 provider 实例独立一套）：
//   Pi agent → modelRuntime.streamSimple（auth 解析 + before_provider_headers 合并）
//     → 本插件 streamSimple wrapper（注入 22 头 + 自定义 fetch）
//     → auth-fetch 拦截器（从 host 注入的 Authorization 解析 token + 认证头注入 + 11133 退避）
//     → ${server}/v2/chat/completions
//
// 凭据唯一事实源是 Pi 的 auth.json（按 provider id 各存一份：codebuddy / codebuddy-intl）：
// Pi 每流解析 + 过期带锁预刷新，经 options.apiKey 注入 Authorization 头；
// 本扩展不再维护本地 token 快照（原 codebuddy-auth.json 已废弃，可手动删除）。
// 模型发现改为懒触发：首个请求携带 token 时发现并重注册。
//
// 双 provider 常驻注册后，原 CODEBUDDY_NETWORK 环境变量废弃：
// 国际侧直接用 codebuddy-intl/... 模型，无需重启切换。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getConfig, resolveServerUrl, SERVER_CN, SERVER_INTL, CHAT_COMPLETIONS_PATH, POLL_TOTAL_TIMEOUT_MS, DEFAULT_EXPIRES_MS, type CodeBuddyServer } from "./config.js";
import { createLogger } from "./log.js";
import { LRUMap } from "./lru.js";
import { PLACEHOLDER_API_KEY, resolveAuth } from "./auth-state.js";
import { requestAuthState, pollForToken, refreshAccessToken } from "./auth-flow.js";
import { createAuthFetch } from "./auth-fetch.js";
import { createCodebuddyStreamSimple } from "./stream.js";
import { buildRequestHeaders, buildAuthHeaders } from "./headers.js";
import { resolveIdentity, decodeJwtPayload } from "./jwt.js";
import { fetchRemoteModels, remoteModelToPi, DEFAULT_MODEL, DiscoveryCache, type RemoteModel } from "./models.js";
import { readCachedModels, writeCachedModels } from "./model-cache.js";

interface ProviderSpec {
  id: string;
  label: string;
  /** 登录 UI 中显示的 OAuth 提供方名称 */
  oauthName: string;
  envPrefix: string;
  server: CodeBuddyServer;
  /** 未认证 401 指引里的 env 变量名 */
  envKeyVar: string;
}

async function createCodebuddyProvider(pi: ExtensionAPI, spec: ProviderSpec): Promise<void> {
  const cfg = getConfig(spec.envPrefix);
  const server = resolveServerUrl(cfg.endpoint, spec.server);
  const logger = createLogger();
  const conversationIds = new LRUMap<string, string>(cfg.conversationMapMax);
  const discoveryCache = new DiscoveryCache({
    ttlMs: 5 * 60 * 1000,
    fetchFn: (token, signal) => fetchRemoteModels(token, server, signal),
  });

  // --- 模型列表 ---
  function modelsFromRemote(remote: RemoteModel[]) {
    return remote.map(remoteModelToPi);
  }
  function fallbackModels() {
    return modelsFromRemote([DEFAULT_MODEL]);
  }
  // 启动种子：优先用上次落盘的模型列表，避免会话恢复时模型还没发现完（见 model-cache.ts）
  // 刻意不打日志：命中缓存是常规路径，每次启动都打印会污染 TUI/print 输出
  const cachedModels = await readCachedModels(spec.id);
  let registeredModels = cachedModels.length ? cachedModels : fallbackModels();

  // 主动发现 + 重注册（registerProvider 可随时调用并立即生效）
  async function discoverAndReregister(token: string): Promise<void> {
    try {
      const remote = await discoveryCache.get(token, { signal: undefined });
      const models = modelsFromRemote(remote);
      if (!models.length) return;
      registeredModels = models;
      register(models);
      await writeCachedModels(models, spec.id);
    } catch (e) {
      const status = (e as any)?.status;
      if (status === 401 || status === 403) {
        logger.warn(`[${spec.id}] model discovery 401/403 — token may be expired, re-run /login ${spec.id}`);
      } else {
        logger.warn(`[${spec.id}] model discovery failed: ${(e as Error).message}`);
      }
    }
  }

  // --- auth-fetch 拦截器 + streamSimple wrapper ---
  // token 来自 host 每流注入的 Authorization（Pi auth.json 解析 + 带锁预刷新）。
  // 懒发现：首个请求携带有效 token 时触发（auth-fetch 对同一 token 只回调一次）；
  // 无本地快照后这是启动后的主要发现入口，模型缓存种子保证发现完成前会话可恢复。
  const authFetch = createAuthFetch({
    resolveAuth: (headers) => resolveAuth(headers, cfg, decodeJwtPayload),
    server,
    buildAuthHeaders,
    resolveIdentity: resolveIdentity as any,
    decodeJwtPayload,
    cfg,
    logger,
    chatCompletionsPath: CHAT_COMPLETIONS_PATH,
    authHint: `run \`/login ${spec.id}\` (oauth) or set ${spec.envKeyVar}`,
    onAuth: (a) => { if (a.type === "oauth") void discoverAndReregister(a.access); },
  });
  const streamSimple = createCodebuddyStreamSimple(authFetch, {
    buildHeaders: (model, options) =>
      buildRequestHeaders(options?.sessionId, model.id, { cfg, server, lru: conversationIds }),
  });

  function register(models: typeof registeredModels) {
    pi.registerProvider(spec.id, {
      name: spec.label,
      baseUrl: `${server.url}/v2`,
      api: "openai-completions",
      // 认证统一由 auth-fetch 拦截器注入（oauth 双头身份 + api 双头 key）；
      // apiKey 仅作为 OpenAI client 的占位（拦截器从 host 注入的 Authorization 解析真实凭据）
      apiKey: cfg.apiKey || PLACEHOLDER_API_KEY,
      models: models as any,
      streamSimple,
      oauth: {
        name: spec.oauthName,
        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const state = await requestAuthState(server.url);
          callbacks.onAuth({ url: state.url, instructions: `请在浏览器中完成 ${spec.label} 登录` });
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS;
          const tok = await pollForToken(server.url, state.state, expiresAt, callbacks.signal);
          if (!tok?.accessToken) throw new Error(`${spec.id} login failed or timed out`);
          const cred: OAuthCredentials = {
            access: tok.accessToken,
            refresh: tok.refreshToken || "",
            expires: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
          // 凭据由 Pi 持久化（auth.json）；登录后立即发现模型并重注册
          void discoverAndReregister(cred.access);
          return cred;
        },
        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          if (!credentials.refresh) throw new Error(`${spec.id}: no refresh token stored`);
          const r = await refreshAccessToken(credentials.refresh, server.url);
          if (!r?.accessToken) throw new Error(`${spec.id}: token refresh failed — re-run /login ${spec.id}`);
          return {
            access: r.accessToken,
            refresh: r.refreshToken || credentials.refresh,
            expires: r.expiresIn ? Date.now() + r.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS,
          };
        },
        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access;
        },
      },
      refreshModels: async (context: RefreshModelsContext) => {
        // Pi 允许网络时按凭据发现；登录后的 credential-change 刷新 allowNetwork=false，走 fallback
        const cred = context.credential?.type === "oauth" ? context.credential : undefined;
        if (cred?.access && context.allowNetwork) {
          try {
            const remote = await discoveryCache.get(cred.access, { signal: context.signal });
            const models = modelsFromRemote(remote);
            if (models.length) {
              registeredModels = models;
              await writeCachedModels(models, spec.id);
              return models as any;
            }
          } catch (e) {
            logger.warn(`[${spec.id}] model discovery failed: ${(e as Error).message}`);
          }
        }
        return registeredModels as any;
      },
    } as any);
  }

  register(registeredModels);

  // api 模式显式请求但无 key：启动即提示（oauth 模式无需提示，未登录时请求会返回 401 指引）
  if (cfg.auth === "api" && !cfg.apiKey) {
    logger.warn(`[${spec.id}] api key mode requested but no key found — set ${spec.envKeyVar}`);
  }

  // --- compaction 后淘汰 conversation-id（对应 opencode session.compacted）---
  pi.on("session_before_compact", (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid) conversationIds.delete(sid);
  });
}

export default async function codebuddyExtension(pi: ExtensionAPI) {
  await createCodebuddyProvider(pi, {
    id: "codebuddy",
    label: "CodeBuddy",
    oauthName: "CodeBuddy (IOA)",
    envPrefix: "CODEBUDDY",
    server: SERVER_CN,
    envKeyVar: "CODEBUDDY_API_KEY",
  });
  await createCodebuddyProvider(pi, {
    id: "codebuddy-intl",
    label: "CodeBuddy Intl",
    oauthName: "CodeBuddy Intl",
    envPrefix: "CODEBUDDY_INTL",
    server: SERVER_INTL,
    envKeyVar: "CODEBUDDY_INTL_API_KEY",
  });
}
