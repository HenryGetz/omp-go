// opencode-go model catalog for omp.
//
// `models-catalog.json` is the `opencode-go` entry of https://models.opencode.ai/api.json
// (the same catalog the harness fetches with its harness User-Agent at
// packages/core/src/models-dev.ts in github.com/anomalyco/opencode), snapshotted
// 2026-10-12. `fetchCatalogModels` refreshes from the live catalog at runtime.

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import catalog from "./models-catalog.json"
import zenCatalog from "./models-zen-catalog.json"
import { DEFAULT_IDENTITY, sessionHeaders, type HarnessIdentity, type SessionIdentity } from "./wire"

type CatalogModel = {
  name?: string
  reasoning?: boolean
  status?: string
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

type CatalogEntry = {
  id: string
  name: string
  api: string
  models: Record<string, CatalogModel>
}

export const CATALOG_URL = "https://models.opencode.ai/api.json"

// Fallbacks for catalog entries missing limit fields (all 36 current models carry them).
const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 32_768

/**
 * Body-shape compat so omp's OpenAI-compatible builder emits the same request
 * fields the harness does: `store`, `stream_options.include_usage`,
 * `max_completion_tokens`, and `reasoning_content` interleaved reasoning.
 */
const HARNESS_COMPAT = {
  supportsStore: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  supportsReasoningEffort: false,
  reasoningContentField: "reasoning_content",
} as const

/**
 * The free lane's body carries no `store` (golden capture: the harness sends
 * only model/messages/stream/stream_options[/tools/max_completion_tokens]).
 */
const FREE_COMPAT = {
  ...HARNESS_COMPAT,
  supportsStore: false,
} as const

/**
 * Models the catalog routes through OpenAI's Responses API (`provider.npm:
 * "@ai-sdk/openai"`) — the gateway rejects them on chat/completions with
 * `ModelProtocolUnsupported`. The harness sends these to `/responses`.
 */
const responsesModels = new Set<string>()

export function usesResponsesAPI(id: string): boolean {
  return responsesModels.has(id)
}

export function toProviderModel(id: string, model: CatalogModel): ProviderModelConfig {
  if ((model as { provider?: { npm?: string } }).provider?.npm === "@ai-sdk/openai") responsesModels.add(id)
  const input = (model.modalities?.input ?? ["text"]).filter(
    (modality): modality is "text" | "image" => modality === "text" || modality === "image",
  )
  return {
    id,
    name: model.name ?? id,
    reasoning: model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cache_read ?? 0,
      cacheWrite: model.cost?.cache_write ?? 0,
    },
    contextWindow: model.limit?.context ?? DEFAULT_CONTEXT,
    maxTokens: model.limit?.output ?? DEFAULT_OUTPUT,
    compat: HARNESS_COMPAT,
  }
}

export const OPENCODE_CATALOG = zenCatalog as CatalogEntry

export function catalogModels(entry: CatalogEntry = catalog as CatalogEntry): ProviderModelConfig[] {
  // The harness hides deprecated catalog models ("Model unavailable"); mirror
  // that so omp's picker and routing only ever see the live set.
  return Object.entries(entry.models)
    .filter(([, model]) => model.status !== "deprecated")
    .map(([id, model]) => toProviderModel(id, model))
}

/** Harness free-tier rule: no cost tier charges for input (`OpencodePlugin`). */
function isFree(model: CatalogModel): boolean {
  const tiers = Array.isArray(model.cost) ? model.cost : [model.cost]
  return !tiers.some((tier) => Number(tier?.input ?? 0) > 0)
}

/**
 * The free tier: exactly the catalog models the harness enables without a key —
 * zero-cost and not deprecated. Under a key the harness shows the paid set on
 * the same provider; omp keeps them separate (`opencode-free` vs `opencode-go`)
 * so the free path can never demand a key.
 */
export function freeModels(entry: CatalogEntry = OPENCODE_CATALOG): ProviderModelConfig[] {
  return Object.entries(entry.models)
    .filter(([, model]) => model.status !== "deprecated" && isFree(model))
    .map(([id, model]) => ({ ...toProviderModel(id, model), compat: FREE_COMPAT }))
}

/** Live refresh of the free set (same catalog fetch, same free/deprecated rules). */
export async function fetchFreeModels(options: {
  session: SessionIdentity
  identity?: HarnessIdentity
  fetch?: typeof fetch
}): Promise<ProviderModelConfig[]> {
  try {
    const response = await (options.fetch ?? fetch)(CATALOG_URL, {
      headers: sessionHeaders(options.session, options.identity ?? DEFAULT_IDENTITY),
    })
    if (!response.ok) return freeModels()
    const payload = (await response.json()) as Record<string, CatalogEntry>
    const entry = payload[(OPENCODE_CATALOG as CatalogEntry).id]
    return entry?.models ? freeModels(entry) : freeModels()
  } catch {
    return freeModels()
  }
}

/**
 * Live refresh through the harness's own models.dev fetch (same URL, same
 * fingerprint headers). Falls back to the embedded snapshot on failure so the
 * provider keeps working offline.
 */
export async function fetchCatalogModels(options: {
  session: SessionIdentity
  identity?: HarnessIdentity
  entryID?: string
  fetch?: typeof fetch
}): Promise<ProviderModelConfig[]> {
  const f = options.fetch ?? fetch
  try {
    const response = await f(CATALOG_URL, {
      headers: sessionHeaders(options.session, options.identity ?? DEFAULT_IDENTITY),
    })
    if (!response.ok) return catalogModels()
    const payload = (await response.json()) as Record<string, CatalogEntry>
    const entry = payload[options.entryID ?? (catalog as CatalogEntry).id]
    return entry?.models ? catalogModels(entry) : catalogModels(entry)
  } catch {
    return catalogModels()
  }
}
