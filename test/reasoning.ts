// Reasoning mapping (src/models.ts): the catalog's per-model reasoning_options
// become omp's thinking config and the harness's own wire shape — effort
// models carry `reasoning_effort` (or `reasoning: {effort, summary:"auto"}` +
// encrypted-reasoning include on the Responses protocol). The default effort
// is the model's HIGHEST rung ("max out quality"), not the harness's
// lightest-variant default — which is what Console requests show as
// `effort · low`. Any explicit session reasoning level still wins.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { catalogModels, freeModels, toProviderModel, usesResponsesAPI } from "../src/models"
import { writeModelsOverride } from "../src/models-config"

// Populate the Responses-model registry the way registration does.
catalogModels()
freeModels()

const goModels = new Map(catalogModels().map((model) => [model.id, model]))
const free = new Map(freeModels().map((model) => [model.id, model]))

// pi-catalog types compat as a per-API union; the fields these asserts pin live
// on the OpenAI-shaped member.
type OpenAICompatView = {
  supportsReasoningEffort?: boolean
  supportsReasoningSummary?: boolean
  includeEncryptedReasoning?: boolean
  supportsStore?: boolean
}
const compatOf = (model: { compat?: unknown } | undefined): OpenAICompatView | undefined =>
  model?.compat as OpenAICompatView | undefined

// 1. Effort model (deepseek-v4.1-flash): full ladder kept, default = max.
{
  const model = goModels.get("deepseek-v4.1-flash")
  assert.ok(model?.thinking, "deepseek-v4.1-flash has a thinking surface")
  assert.equal(model.thinking.mode, "effort")
  assert.deepEqual([...model.thinking.efforts], ["low", "high", "max"])
  assert.equal(model.thinking.defaultLevel, "max", "default effort is the model's highest rung")
  assert.equal(compatOf(model)?.supportsReasoningEffort, true, "wire carries reasoning_effort")
}

// 2. Responses model (gpt-6-luna): same max default, summary/include compat
// for the harness's `reasoning: {effort, summary:"auto"}` + encrypted include.
{
  const model = goModels.get("gpt-6-luna")
  assert.ok(model?.thinking, "gpt-6-luna has a thinking surface")
  assert.deepEqual([...model.thinking.efforts], ["low", "medium", "high", "xhigh", "max"], '"none" is the off switch, not a rung')
  assert.equal(model.thinking.defaultLevel, "max")
  assert.equal(compatOf(model)?.supportsReasoningSummary, true)
  assert.equal(compatOf(model)?.includeEncryptedReasoning, true)
  assert.equal(usesResponsesAPI("gpt-6-luna"), true)
}

// 3. Single-rung vocab (kimi-k3: ["max"]).
{
  const kimi = goModels.get("kimi-k3")
  assert.deepEqual([...(kimi?.thinking?.efforts ?? [])], ["max"])
  assert.equal(kimi?.thinking?.defaultLevel, "max")
}

// 4. No controllable surface (mimo-v2.6-pro: no options; longcat:
// toggle-only) — the harness sends nothing for these on the gateway either.
{
  const mimo = goModels.get("mimo-v2.6-pro")
  assert.equal(mimo?.thinking, undefined, "mimo has no effort surface")
  assert.equal(compatOf(mimo)?.supportsReasoningEffort, false, "no reasoning field on the wire")
  const longcat = goModels.get("longcat-2.5-preview-free")
  assert.equal(longcat?.thinking, undefined, "toggle-only stays uncontrolled")
}

// 5. Free lane keeps the same mapping and drops `store`.
{
  const model = free.get("space-bunny-free")
  assert.ok(model?.thinking, "free effort model carries the thinking surface")
  assert.deepEqual([...(model.thinking.efforts ?? [])], ["low", "medium", "high", "xhigh", "max"])
  assert.equal(model.thinking.defaultLevel, "max")
  assert.equal(compatOf(model)?.supportsReasoningEffort, true)
  assert.equal(compatOf(model)?.supportsStore, false, "free bodies carry no store")
}

// 6. "none" and unknown strings are never offered as efforts; a vocab with no
// standard rung yields no surface; the default is ladder order, not list order.
{
  const model = toProviderModel("synthetic", {
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "high"] }],
  })
  assert.deepEqual([...(model.thinking?.efforts ?? [])], ["high"])
  assert.equal(model.thinking?.defaultLevel, "high")
  const unordered = toProviderModel("synthetic-unordered", {
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["xhigh", "low"] }],
  })
  assert.deepEqual([...(unordered.thinking?.efforts ?? [])], ["low", "xhigh"])
  assert.equal(unordered.thinking?.defaultLevel, "xhigh", "max is ladder order, not list order")
  const junk = toProviderModel("synthetic-junk", {
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["turbo", "ultra"] }],
  })
  assert.equal(junk.thinking, undefined, "unknown vocab maps to no surface")
}

// 7. The models.yml maintainer writes the mapping as per-model overrides
// (modelOverrides out-rank the provider-level compat): effort models pin
// their ladder + max default + reasoning on; everything else gets no entry
// and stays fieldless under the provider-level false.
{
  const home = mkdtempSync(path.join(tmpdir(), "omp-go-reasoning-"))
  const previousHome = process.env.HOME
  try {
    process.env.HOME = home
    writeModelsOverride()
    const yml = readFileSync(path.join(home, ".omp", "agent", "models.yml"), "utf8")
    assert.ok(yml.includes("modelOverrides:"), "managed block carries per-model reasoning overrides")
    assert.match(
      yml,
      /"deepseek-v4\.1-flash":\n\s+thinking:\n\s+mode: effort\n\s+efforts: \[low, high, max\]\n\s+defaultLevel: max\n\s+compat:\n\s+supportsReasoningEffort: true/,
      "deepseek pins its ladder with the max default and reasoning enabled",
    )
    assert.ok(
      !/"mimo-v2\.6-pro":/.test(yml),
      "mimo (no effort surface) gets no override — the provider default keeps it fieldless",
    )
    assert.match(yml, /"space-bunny-free":[\s\S]*?defaultLevel: max/, "free lane carries the same mapping")
    assert.ok(
      yml.split("supportsReasoningEffort: false").length - 1 === 2,
      "provider-level default stays false on both lanes",
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

console.log("REASONING OK: per-model effort mapping, max default, harness wire shapes")
