// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Ming Lo — 源自 https://github.com/minglo/opencode-codebuddy-oauth (MIT)
// src/models.ts — 平移自 opencode-codebuddy-oauth；RemoteModel → Pi ProviderModelConfig
import { fetchJson } from "./fetch-json.js";
import { AGENT_INTENT, DISCOVERY_TIMEOUT_MS, IDE_NAME, IDE_TYPE, IDE_VERSION, APP_VERSION, ENV_ID, PRODUCT } from "./config.js";

export interface RemoteModel { id:string; name:string; maxInputTokens?:number; maxOutputTokens?:number; maxAllowedSize?:number; supportsToolCall?:boolean; supportsImages?:boolean; supportsReasoning?:boolean; disabledMultimodal?:boolean; reasoning?:{ effort?:string; defaultEffort?:string; supportedEfforts?:string[] }; }
export const DEFAULT_MODEL: RemoteModel = { id:"auto", name:"Auto", maxInputTokens:168000, maxOutputTokens:32000, supportsToolCall:true };

export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string>;
}

export interface RemoteConfigResponse { code:number; data?:{ agents?:Array<{name:string; models?:string[]}>; models?:RemoteModel[] } }
export async function fetchRemoteModels(
  accessToken: string,
  server: { url: string; domain: string },
  signal?: AbortSignal,
): Promise<RemoteModel[]> {
  const headers: Record<string,string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": AGENT_INTENT,
    "X-IDE-Type": IDE_TYPE, "X-IDE-Name": IDE_NAME, "X-IDE-Version": IDE_VERSION,
    "X-Product-Version": APP_VERSION, "X-Env-ID": ENV_ID,
    "X-Domain": server.domain, "X-Product": PRODUCT,
    "User-Agent": `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
  };
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers, timeoutMs: DISCOVERY_TIMEOUT_MS, signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`discovery ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return [];
  }
  const body = res.data;
  if (!body || body.code !== 0 || !body.data) return [];
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === AGENT_INTENT);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false);
}

const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
  return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

function detectImages(id: string): boolean {
  return /claude|gemini|gpt/i.test(id);
}

/** RemoteModel → Pi ProviderModelConfig 所需字段 */
export function remoteModelToPi(m: RemoteModel): PiModelConfig {
  const contextWindow = m.maxAllowedSize ?? m.maxInputTokens ?? DEFAULT_CONTEXT;
  const maxTokens = m.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const cfg: PiModelConfig = {
    id: m.id,
    name: m.name,
    reasoning: m.supportsReasoning !== false && detectThinking(m.id),
    input: (detectImages(m.id) && !m.disabledMultimodal) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  const effort = m.reasoning?.defaultEffort ?? m.reasoning?.effort;
  const efforts = m.reasoning?.supportedEfforts;
  if (cfg.reasoning && efforts?.length) {
    cfg.thinkingLevelMap = Object.fromEntries(efforts.map((e) => [e, e]));
    if (effort) cfg.thinkingLevelMap.default = effort;
  }
  return cfg;
}

export class DiscoveryCache {
  private data: RemoteModel[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<RemoteModel[]> | null = null;
  private readonly fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>;
  constructor(private opts: { ttlMs:number; fetchFn: (token: string, signal?: AbortSignal)=>Promise<RemoteModel[]> }) { this.fetchFn = opts.fetchFn; }
  async get(token:string, { signal }: { signal?:AbortSignal }): Promise<RemoteModel[]> {
    const now = Date.now();
    if (this.data && (now - this.fetchedAt) < this.opts.ttlMs) return this.data;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFn(token, signal).then(d => { this.data = d; this.fetchedAt = Date.now(); return d; }).catch(e => {
      if ((e as any)?.status === 401 || (e as any)?.status === 403) throw e;
      if (!this.data) { this.data = [DEFAULT_MODEL]; this.fetchedAt = now; return this.data; }
      return this.data;
    }).finally(() => { this.inflight = null; });
    if (this.data) { this.inflight.catch(() => {}); return this.data; }
    return this.inflight;
  }
}
