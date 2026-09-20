// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/config.ts — 平移自 opencode-codebuddy-oauth；去掉 SSE 配置与 OpenCode auth.json 路径
//
// 双 provider：同一扩展注册 codebuddy（国内）与 codebuddy-intl（国际）两个实例，
// 各自持有独立的 envPrefix（CODEBUDDY_* / CODEBUDDY_INTL_*）与默认 server。
// 原 CODEBUDDY_NETWORK 环境变量已废弃：两个 provider 常驻注册，无需重启切换网络。
export const CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
export const PLATFORM = "VSCode";
export const APP_VERSION = "4.9.29177644";
export const IDE_NAME = "VSCode";
export const IDE_TYPE = "VSCode";
export const IDE_VERSION = "1.119.0";
export const DOMAIN_DEFAULT = "www.codebuddy.cn";
export const PRODUCT = "SaaS";
export const AGENT_INTENT = "craft";
export const ENV_ID = "production";
export const DISCOVERY_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 8000;
export const POLL_TOTAL_TIMEOUT_MS = 10*60*1000;
export const AUTH_STATE_TIMEOUT_MS = 5000;
export const REFRESH_TIMEOUT_MS = 5000;
export const REFRESH_SKEW_MS = 5*60*1000;
export const DEFAULT_EXPIRES_MS = 24*60*60*1000;
export const DISCOVERY_CACHE_TTL_MS = 5*60*1000;

export interface CodeBuddyServer { url: string; domain: string }

/** 国内端点（copilot.tencent.com / IOA） */
export const SERVER_CN: CodeBuddyServer = { url: "https://copilot.tencent.com", domain: "www.codebuddy.cn" };
/** 国际端点（www.codebuddy.ai） */
export const SERVER_INTL: CodeBuddyServer = { url: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" };

export interface CodeBuddyConfig {
  endpoint: string; auth: "auto"|"oauth"|"api";
  model?: string; stableConversationId: boolean; conversationMapMax: number;
  tenantId?:string; enterpriseId?:string; userId?:string;
  apiKey?:string; platform:string; appVersion:string; ideName:string; ideType:string; ideVersion:string;
  domain:string; product:string; agentIntent:string; envId:string;
}

function num(v: string | undefined, d: number): number {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/** 按 envPrefix 读取配置：`codebuddy` → CODEBUDDY_*，`codebuddy-intl` → CODEBUDDY_INTL_* */
export function getConfig(envPrefix: string): CodeBuddyConfig {
  const env = (name: string) => process.env[`${envPrefix}_${name.toUpperCase()}`] || "";
  return {
    endpoint: env("endpoint") || "",
    auth: (env("auth") || "auto").toLowerCase() as CodeBuddyConfig["auth"],
    model: env("model") || "",
    stableConversationId: env("stable_conversation") !== "0",
    conversationMapMax: num(env("conversation_map_max"), 1000),
    tenantId: env("tenant_id") || "",
    enterpriseId: env("enterprise_id") || "",
    userId: env("user_id") || "",
    apiKey: env("api_key") || "",
    platform: PLATFORM, appVersion: APP_VERSION, ideName: IDE_NAME, ideType: IDE_TYPE, ideVersion: IDE_VERSION,
    domain: DOMAIN_DEFAULT, product: PRODUCT, agentIntent: AGENT_INTENT, envId: ENV_ID,
  };
}

export function domainForHost(url: string): string {
  try { return new URL(url).host.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; } catch { return url.includes("codebuddy.ai") ? "www.codebuddy.ai" : "www.codebuddy.cn"; }
}

/** endpoint 覆盖优先；否则用 provider 实例的默认 server */
export function resolveServerUrl(endpoint: string, fallback: CodeBuddyServer): CodeBuddyServer {
  if (!endpoint) return fallback;
  const url = endpoint.replace(/\/+$/, "");
  return { url, domain: domainForHost(url) };
}
