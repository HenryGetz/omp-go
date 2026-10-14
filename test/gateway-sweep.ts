// Sweep every free model against the real gateway (network required).
//
// Both wire protocols ride the free lane: chat/completions and the Responses
// API (catalog models with `provider.npm: "@ai-sdk/openai"`). A model that
// mis-routes dies with `Model does not support this protocol` — so the sweep
// is the only honest way to say the free tier works.
//
//   bun test/gateway-sweep.ts

import { readFileSync } from "node:fs"
import { freeModels, usesResponsesAPI } from "../src/models"
import { harnessFetch } from "../src/ordered-fetch"

// A real agent-conversation body (the free tier's gate checks the payload is
// one) with only the model swapped per request.
const completionsBody = JSON.parse(readFileSync(new URL("./fixtures/omp-body.json", import.meta.url), "utf8"))
const responsesBody = JSON.parse(readFileSync(new URL("./fixtures/responses-body.json", import.meta.url), "utf8"))

let broken = 0
let upstream = 0
for (const model of freeModels()) {
  const responses = usesResponsesAPI(model.id)
  const body = JSON.stringify({ ...(responses ? responsesBody : completionsBody), model: model.id })
  const url = `https://opencode.ai/inference/v1/${responses ? "responses" : "chat/completions"}`
  try {
    const res = await harnessFetch(url, { method: "POST", headers: { authorization: "Bearer public" }, body })
    const text = await res.text()
    const protocol = responses ? "responses" : "completions"
    if (res.status === 200) {
      console.log(`ok   ${model.id} (${protocol})`)
      continue
    }
    // Routing/protocol problems are ours; availability drift is upstream's.
    const ours = res.status === 400 && !/unavailable/i.test(text) && !/"type":"Model"/.test(text)
    if (ours) {
      broken++
      console.log(`FAIL ${model.id} (${protocol}) -> ${res.status} ${text.slice(0, 90)}`)
    } else {
      upstream++
      console.log(`drft ${model.id} (${protocol}) -> ${res.status} (upstream: ${text.slice(0, 60).replace(/\n/g, " ")})`)
    }
  } catch (error) {
    broken++
    console.log(`FAIL ${model.id} -> ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (broken > 0) {
  console.error(`SWEEP FAIL: ${broken} models mis-routed by us`)
  process.exit(1)
}
console.log(`SWEEP OK: every free model routes correctly (${upstream} with upstream availability drift noted)`)
