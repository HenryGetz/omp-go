// opencode-go model catalog for omp.
//
// `models-catalog.json` is the `opencode-go` entry of https://models.opencode.ai/api.json
// (the same catalog the harness fetches with its harness User-Agent at
// packages/core/src/models-dev.ts in github.com/anomalyco/opencode), snapshotted
// 2026-10-12. `fetchCatalogModels` refreshes from the live catalog at runtime.

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { THINKING_EFFORTS, type Effort } from "@oh-my-pi/pi-catalog/effort"
import { isDeadModel } from "./dead-models"
import catalog from "./models-catalog.json"
import zenCatalog from "./models-zen-catalog.json"
import { DEFAULT_IDENTITY, sessionHeaders, type HarnessIdentity, type SessionIdentity } from "./wire"

type CatalogModel = {
  name?: string
  reasoning?: boolean
  reasoning_options?: { type?: string; values?: string[] }[]
  status?: string
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  provider?: { npm?: string }
}

export type CatalogEntry = {
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
 * Models the catalog routes through OpenAI's Responses API (`provider.npm:
 * "@ai-sdk/openai"`) — the gateway rejects them on chat/completions with
 * `ModelProtocolUnsupported`. The harness sends these to `/responses`.
 */
const responsesModels = new Set<string>()

export function usesResponsesAPI(id: string): boolean {
  return responsesModels.has(id)
}

/**
 * The catalog's per-model reasoning knobs (`reasoning_options`) mapped to omp's
 * canonical thinking config. Effort-capable models wire `reasoning_effort` (or
 * `reasoning.effort` on the Responses protocol) exactly as the harness's own
 * variant overlays spell them (opencode `packages/core/src/variant.ts`:
 * `openaiChat` → `settings.reasoningEffort`, `openaiResponses` →
 * `reasoning: {effort, summary:"auto"}` + encrypted-reasoning include).
 * Toggle-only and budget-only models have no controllable surface on these
 * gateways — the harness sends nothing for them either.
 *
 * `defaultLevel` is the model's HIGHEST supported effort ("max out quality").
 * The harness's default variant is `values[0]` — the lightest rung, which is
 * why Console requests read `effort · low`. omp applies `defaultLevel` at
 * model selection; any explicit session reasoning level still wins.
 */
function thinkingFor(model: CatalogModel): ProviderModelConfig["thinking"] {
  const effort = model.reasoning_options?.find((option) => option.type === "effort")
  if (!effort) return undefined
  const supported = (effort.values ?? ["low", "medium", "high"]).filter((value): value is Effort =>
    (THINKING_EFFORTS as readonly string[]).includes(value),
  )
  if (supported.length === 0) return undefined
  const ordered = [...supported].sort((left, right) => THINKING_EFFORTS.indexOf(left) - THINKING_EFFORTS.indexOf(right))
  return { mode: "effort", efforts: ordered, defaultLevel: ordered[ordered.length - 1] }
}

export function toProviderModel(id: string, model: CatalogModel): ProviderModelConfig {
  const isResponses = model.provider?.npm === "@ai-sdk/openai"
  if (isResponses) responsesModels.add(id)
  const thinking = thinkingFor(model)
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
    ...(thinking ? { thinking } : {}),
    compat: {
      ...HARNESS_COMPAT,
      // Effort-capable models carry `reasoning_effort` like the harness's
      // effort variant; models without a controllable surface send nothing.
      ...(thinking ? { supportsReasoningEffort: true } : {}),
      // Responses models: `reasoning: {effort, summary:"auto"}` plus the
      // encrypted-reasoning include (harness `responsesEffort` overlay).
      ...(isResponses ? { supportsReasoningSummary: true, includeEncryptedReasoning: true } : {}),
    },
  }
}

export const OPENCODE_CATALOG = zenCatalog as CatalogEntry
/** The Go subscription's catalog entry (the `opencode-go` lane). */
export const GO_CATALOG = catalog as CatalogEntry

/**
 * Per-model `thinking` overrides for the models.yml maintainer
 * (src/models-config.ts): effort-capable models pin their ladder and the
 * MAX default (`defaultLevel`) so requests carry the model's highest rung
 * (`reasoning_effort`, or `reasoning.effort` on the Responses protocol)
 * without any per-session configuration. Only models with an `effort`
 * surface get an entry — everything else keeps the provider-level
 * `supportsReasoningEffort: false` and sends no reasoning fields, exactly
 * like the harness.
 */
export function thinkingOverrides(
  entry: CatalogEntry,
): { id: string; thinking: NonNullable<ProviderModelConfig["thinking"]> }[] {
  return Object.entries(entry.models)
    .map(([id, model]) => ({ id, thinking: thinkingFor(model) }))
    .filter((item): item is { id: string; thinking: NonNullable<ProviderModelConfig["thinking"]> } => item.thinking !== undefined)
}

export function catalogModels(entry: CatalogEntry = catalog as CatalogEntry): ProviderModelConfig[] {
  // The harness hides deprecated catalog models ("Model unavailable"); mirror
  // that so omp's picker and routing only ever see the live set. The dead set
  // (src/dead-models.ts) also applies here: a Go-lane model the gateway
  // retired must leave the provider's list the moment we learn it, not at the
  // next catalog snapshot.
  return Object.entries(entry.models)
    .filter(([id, model]) => model.status !== "deprecated" && !isDeadModel(id))
    .map(([id, model]) => toProviderModel(id, model))
}

/** Harness free-tier rule: no cost tier charges for input (`OpencodePlugin`). */
function isFree(model: CatalogModel): boolean {
  const tiers = Array.isArray(model.cost) ? model.cost : [model.cost]
  return !tiers.some((tier) => Number(tier?.input ?? 0) > 0)
}

/**
 * The free tier: exactly the catalog models the harness enables without a key —
 * zero-cost, not deprecated, and not dead (src/dead-models.ts: the static seed
 * plus every retirement learned at runtime). Under a key the harness shows the
 * paid set on the same provider; omp keeps them separate (`opencode-free` vs
 * `opencode-go`) so the free path can never demand a key.
 */
export function freeModels(entry: CatalogEntry = OPENCODE_CATALOG): ProviderModelConfig[] {
  return allFreeModels(entry).filter((model) => !isDeadModel(model.id))
}

/** The raw free set (no dead-model filter) — what `bun test/gateway-sweep.ts` sweeps.
 * The free lane's body carries no `store` (golden capture: the harness sends
 * only model/messages/stream/stream_options[/tools/max_completion_tokens]);
 * everything else matches the harness compat the model builder derives.
 */
export function allFreeModels(entry: CatalogEntry = OPENCODE_CATALOG): ProviderModelConfig[] {
  return Object.entries(entry.models)
    .filter(([, model]) => model.status !== "deprecated" && isFree(model))
    .map(([id, model]) => {
      const built = toProviderModel(id, model)
      return { ...built, compat: { ...built.compat, supportsStore: false } }
    })
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
