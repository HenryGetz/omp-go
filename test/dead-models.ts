// Dynamic dead-model learning (src/dead-models.ts): a gateway deprecation
// failure marks the model dead AT RUNTIME — the free-roster derivation and the
// /freeusage row set drop it, the user-visible error names the model as
// RETIRED UPSTREAM with live alternatives, and the mark persists for every
// later omp process. A NON-deprecation 410 or a 404 never marks; the
// account-verdict machinery and the 429 lane are not involved.

// Isolate HOME before the state sidecars load: these tests write the dead
// set, and they must never touch the real ~/.omp state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
const dir = mkdtempSync(path.join(tmpdir(), "omp-go-dead-models-test-"))
process.env.HOME = dir

import assert from "node:assert/strict"
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import {
  clearLearnedDeadModels,
  deadModels,
  isDeadModel,
  isDeprecationFailure,
  mapDeprecationErrors,
  markModelDead,
  retirementNote,
  SEED_DEAD_MODELS,
} from "../src/dead-models"
import { freeModels } from "../src/models"
import { freeLaneIds, freeUsageReport } from "../src/free-usage"

const DEAD_FILE = path.join(dir, ".omp", "agent", "omp-go-dead-models.json")

// Live free models of the embedded snapshot, used as fixtures.
const MODEL = "mimo-v2.6-flash-free"
const MODEL2 = "nemotron-3-ultra-free"
const NOT_DEAD_410 = "cat-jam-free"
const NOT_DEAD_404 = "big-pickle"
const OTHER = "step-5-preview-free"

// The in-stream failure shape: a `type: "error"` event whose `error` is an
// AssistantMessage carrying errorMessage/errorStatus (what the free lane's
// gateway 410 actually produced today, verbatim).
const gatewayErrorEvent = (model: string, status = 410) =>
  ({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "opencode-free",
      model,
      stopReason: "error",
      errorStatus: status,
      errorMessage:
        status === 410
          ? `410 Model ${model} has been deprecated.\nModel ${model} has been deprecated. (type=ModelDeprecated)`
          : `${status} upstream failure`,
    },
  }) as never

async function failureOf(source: AssistantMessageEventStream) {
  try {
    for await (const _event of source) {
      // drain
    }
    await source.result()
    return undefined
  } catch (error) {
    return error as { status?: number; message?: string; code?: string }
  }
}

async function errorEventOf(source: AssistantMessageEventStream) {
  for await (const event of source) {
    if (event.type === "error") return event
  }
  await source.result()
  return undefined
}

// ------------------------------------------------------------------ detection
assert.equal(isDeprecationFailure({ status: 410, message: `410 Model ${MODEL} has been deprecated.` }), true)
assert.equal(
  isDeprecationFailure({ status: 400, message: `Model ${MODEL} has been deprecated. (type=ModelDeprecated)` }),
  true,
  "type=ModelDeprecated alone marks, whatever the status",
)
assert.equal(isDeprecationFailure({ code: "ModelDeprecated" }), true)
assert.equal(
  isDeprecationFailure({ status: 410, message: "410 the session channel is gone" }),
  false,
  "a NON-deprecation 410 must never mark a model dead",
)
assert.equal(isDeprecationFailure({ status: 404, message: "404 no such model" }), false, "a 404 never marks")
assert.equal(isDeprecationFailure({ status: 429, message: "429 too many requests" }), false)
assert.equal(isDeprecationFailure(undefined), false)
// The thrown Error shape: `message` is non-enumerable, so a plain entries/
// JSON walk would miss it — the detector must read it explicitly.
{
  const err = new Error(`410 Model ${MODEL} has been deprecated.`)
  ;(err as { status?: number }).status = 410
  ;(err as { code?: string }).code = "ModelDeprecated"
  assert.equal(isDeprecationFailure(err), true, "Error.message is part of the carrier")
}
// The in-stream event shape the free lane actually produced.
assert.equal(isDeprecationFailure(gatewayErrorEvent(MODEL)), true)

// ------------------------------------------------------------------ the seed
assert.ok(SEED_DEAD_MODELS.has("exo-free") && SEED_DEAD_MODELS.has("ling-3.0-flash-fin-free"))
assert.ok(deadModels().has("exo-free"), "the hand-verified seed stays in the shared set")
assert.ok(freeModels().every((model) => model.id !== "exo-free"), "seed models are filtered from the roster")

// ------------------------------------------------- in-stream failure → mark
{
  assert.ok(freeModels().some((model) => model.id === MODEL), "fixture model starts live")
  let retired: string | undefined
  const src = createAssistantMessageEventStream()
  const out = mapDeprecationErrors(src, {
    modelId: MODEL,
    alternatives: () => freeModels().map((model) => model.id),
    freeUsageHint: true,
    onRetired: (id) => {
      retired = id
    },
  })
  src.push(gatewayErrorEvent(MODEL) as never)

  const event = await errorEventOf(out)
  assert.equal(event?.type, "error", "the failure still arrives as a loud error event")
  const message = (event as { error?: { errorMessage?: string } } | undefined)?.error?.errorMessage ?? ""
  assert.match(message, /RETIRED UPSTREAM/, "the error names the retirement")
  assert.match(message, new RegExp(MODEL), "the error names the model")
  assert.match(message, /type=ModelDeprecated/, "the gateway's classification stays visible")
  assert.match(message, /Use a live model instead/, "the error points at what to use instead")
  assert.match(message, new RegExp(OTHER), "the alternatives include a live free model")
  assert.doesNotMatch(message, new RegExp(`Use a live model instead: [^\\n]*${MODEL}`), "the dead model is not its own alternative")
  assert.match(message, /\/model/, "the error hints the /model command")
  assert.match(message, /\/freeusage/, "the free lane also hints /freeusage")
  assert.ok(retired === MODEL, "the roster-heal hook fired with the model id")

  assert.equal(isDeadModel(MODEL), true, "the model is marked dead at runtime")
  const roster = freeModels().map((model) => model.id)
  assert.ok(!roster.includes(MODEL), "the free-roster derivation excludes it")
  assert.ok(roster.includes(OTHER) && roster.includes(NOT_DEAD_410), "every other model is unaffected")
  assert.ok(freeLaneIds([]).includes(OTHER), "the /freeusage row set still carries live models")

  // Persistence: the mark lands in the state file so later processes start
  // with it learned.
  const persisted = JSON.parse(readFileSync(DEAD_FILE, "utf8")) as Record<string, { at?: unknown }>
  assert.equal(typeof persisted[MODEL]?.at, "number", "the state file records the mark with a timestamp")
  assert.equal(markModelDead(MODEL), false, "a repeat mark is a no-op")

  // The /freeusage row set: a historical free-lane row for the dead model
  // must not present it as an idle-but-usable row.
  const ledger = path.join(dir, "ledger.ndjson")
  const at = new Date(Date.now() - 60_000).toISOString()
  const row = (model: string) =>
    JSON.stringify({ ts: at, method: "POST", path: "/inference/v1/chat/completions", hop: "direct", bytes: 7, model })
  writeFileSync(ledger, `${[row(MODEL), row(OTHER)].join("\n")}\n`)
  const report = freeUsageReport({ file: ledger })
  assert.doesNotMatch(report, new RegExp(`^${MODEL} `, "m"), "the dead model gets no /freeusage row")
  assert.match(report, new RegExp(`^${OTHER} `, "m"), "the live model keeps its row")
}

// ------------------------------------------------ thrown failure → mark too
{
  let retired: string | undefined
  const src = createAssistantMessageEventStream()
  const out = mapDeprecationErrors(src, {
    modelId: MODEL2,
    alternatives: () => freeModels().map((model) => model.id),
    onRetired: (id) => {
      retired = id
    },
  })
  // A REAL Error instance, the shape streamSimple rejects with: `message` is
  // NON-enumerable, so the rewrite must reach for it explicitly.
  const rejection = new Error(`410 Model ${MODEL2} has been deprecated. (type=ModelDeprecated)`)
  ;(rejection as { status?: number }).status = 410
  ;(rejection as { code?: string }).code = "ModelDeprecated"
  src.fail(rejection)
  const error = await failureOf(out)
  assert.match(error?.message ?? "", /RETIRED UPSTREAM/, "a thrown rejection gets the same loud note")
  assert.match(error?.message ?? "", new RegExp(MODEL2))
  assert.match(error?.message ?? "", /type=ModelDeprecated/)
  assert.ok(retired === MODEL2)
  assert.equal(isDeadModel(MODEL2), true)
  assert.ok(!freeModels().some((model) => model.id === MODEL2), "the roster drops the thrown-path mark as well")
}

// ------------------------------------- non-deprecation failures never mark
{
  let retired = false
  const src = createAssistantMessageEventStream()
  const out = mapDeprecationErrors(src, {
    modelId: NOT_DEAD_410,
    alternatives: () => [],
    onRetired: () => {
      retired = true
    },
  })
  src.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "opencode-free",
      model: NOT_DEAD_410,
      stopReason: "error",
      errorStatus: 410,
      errorMessage: "410 the session channel is gone",
    },
  } as never)
  const event = await errorEventOf(out)
  const message = (event as { error?: { errorMessage?: string } } | undefined)?.error?.errorMessage ?? ""
  assert.equal(retired, false, "the heal hook never fires")
  assert.equal(isDeadModel(NOT_DEAD_410), false, "a non-deprecation 410 never marks the model dead")
  assert.ok(freeModels().some((model) => model.id === NOT_DEAD_410), "the model stays on the roster")
  assert.doesNotMatch(message, /RETIRED UPSTREAM/, "a non-deprecation failure is never rewritten")
  assert.equal(message, "410 the session channel is gone", "the error passes through byte-identical")
}

{
  const src = createAssistantMessageEventStream()
  const out = mapDeprecationErrors(src, { modelId: NOT_DEAD_404, alternatives: () => [] })
  src.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "opencode-free",
      model: NOT_DEAD_404,
      stopReason: "error",
      errorStatus: 404,
      errorMessage: "404 no such model",
    },
  } as never)
  const event = await errorEventOf(out)
  const message = (event as { error?: { errorMessage?: string } } | undefined)?.error?.errorMessage ?? ""
  assert.equal(isDeadModel(NOT_DEAD_404), false, "a 404 never marks the model dead")
  assert.doesNotMatch(message, /RETIRED UPSTREAM/, "an unrelated failure is never rewritten")
  assert.equal(message, "404 no such model", "unrelated errors pass through byte-identical")
}

// Other lanes pass through untouched: a 429 stays a 429-shaped failure.
{
  const src = createAssistantMessageEventStream()
  const out = mapDeprecationErrors(src, { modelId: OTHER, alternatives: () => [] })
  src.fail({ status: 429, message: "429 too many requests" })
  const error = await failureOf(out)
  assert.equal(error?.status, 429, "rate limits are untouched")
  assert.equal(error?.message, "429 too many requests")
}

// ------------------------------------- cross-process: the FILE is the truth
{
  clearLearnedDeadModels()
  assert.equal(isDeadModel(MODEL), false, "the test hook clears the learned marks")
  // Another omp process marks a model: only the state file carries the mark.
  const otherProcessMark = NOT_DEAD_410
  writeFileSync(DEAD_FILE, JSON.stringify({ [otherProcessMark]: { at: Date.now() } }), { mode: 0o600 })
  assert.equal(isDeadModel(otherProcessMark), true, "a persisted mark reaches a process with empty memory")
  assert.ok(!freeModels().some((model) => model.id === otherProcessMark), "the roster honors the persisted mark")
}

// --------------------------------------------------------------- note shape
{
  const note = retirementNote(MODEL, { alternatives: [MODEL, OTHER], freeUsageHint: true })
  assert.doesNotMatch(note, new RegExp(`instead: [^\\n]*${MODEL}`), "the note never lists the dead model as an alternative")
  assert.match(note, new RegExp(OTHER))
  const bare = retirementNote(MODEL)
  assert.match(bare, /Run \/model to pick a live model/, "without a roster the note falls back to /model")
}

rmSync(dir, { recursive: true, force: true })
console.log("DEAD-MODELS OK: deprecation failures learn retirements at runtime; plain 404/410s never mark")
