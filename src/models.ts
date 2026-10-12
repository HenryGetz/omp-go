// opencode-go model catalog for omp.
//
// `models-catalog.json` is the `opencode-go` entry of https://models.opencode.ai/api.json
// (the same catalog the harness fetches with its harness User-Agent at
// packages/core/src/models-dev.ts in github.com/anomalyco/opencode), snapshotted
// 2026-10-12. `fetchCatalogModels` refreshes from the live catalog at runtime.

import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import catalog from "./models-catalog.json"
import { DEFAULT_IDENTITY, sessionHeaders, type HarnessIdentity, type SessionIdentity } from "./wire"

type CatalogModel = {
  name?: string
  reasoning?: boolean
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

export function toProviderModel(id: string, model: CatalogModel): ProviderModelConfig {
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
  }
}

export function catalogModels(entry: CatalogEntry = catalog as CatalogEntry): ProviderModelConfig[] {
  return Object.entries(entry.models).map(([id, model]) => toProviderModel(id, model))
}

/**
 * Live refresh through the harness's own models.dev fetch (same URL, same
 * fingerprint headers). Falls back to the embedded snapshot on failure so the
 * provider keeps working offline.
 */
export async function fetchCatalogModels(options: {
  session: SessionIdentity
  identity?: HarnessIdentity
  fetch?: typeof fetch
}): Promise<ProviderModelConfig[]> {
  const f = options.fetch ?? fetch
  try {
    const response = await f(CATALOG_URL, {
      headers: sessionHeaders(options.session, options.identity ?? DEFAULT_IDENTITY),
    })
    if (!response.ok) return catalogModels()
    const payload = (await response.json()) as Record<string, CatalogEntry>
    const entry = payload[(catalog as CatalogEntry).id]
    return entry?.models ? catalogModels(entry) : catalogModels()
  } catch {
    return catalogModels()
  }
}
