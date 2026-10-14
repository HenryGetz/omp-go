// Cross-process state lock: concurrent omp runs must never lose a shared-state
// update. Every worker performs read-modify-write cycles on one file; without
// serialization the count lands below the total (lost updates), with the lock
// it must be exact.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCK_MODULE = path.resolve(HERE, "..", "src", "state-lock.ts")
const WORKERS = 4
const LOOPS = 25

const home = mkdtempSync(path.join(tmpdir(), "omp-go-lock-"))
const counter = path.join(home, "counter.json")
writeFileSync(counter, '{"n":0}')

const worker = `
import { readFileSync, writeFileSync } from "node:fs"
import { withStateLock } from ${JSON.stringify(LOCK_MODULE)}
for (let i = 0; i < ${LOOPS}; i++) {
  withStateLock(() => {
    const n = JSON.parse(readFileSync(${JSON.stringify(counter)}, "utf8")).n
    writeFileSync(${JSON.stringify(counter)}, JSON.stringify({ n: n + 1 }))
  })
}
`

const kids = Array.from({ length: WORKERS }, () =>
  spawnSync("bun", ["-e", worker], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 }),
)
for (const [index, kid] of kids.entries()) {
  assert.equal(kid.status, 0, `worker ${index} failed: ${String(kid.stderr).slice(0, 200)}`)
}
const total = JSON.parse(readFileSync(counter, "utf8")).n
assert.equal(total, WORKERS * LOOPS, `lost updates under concurrency: ${total}/${WORKERS * LOOPS}`)

console.log(`STATE-LOCK OK: ${WORKERS} concurrent writers x ${LOOPS} read-modify-writes, zero lost updates`)

// Real surfaces: concurrent omp processes updating the actual sidecars must
// lose nothing, and the models.yml maintainer must neither duplicate its
// managed block nor drop user content between interleaved rewrites.
{
  const RLOOPS = 5
  const ROUTING = path.resolve(HERE, "..", "src", "routing.ts")
  const VERDICTS = path.resolve(HERE, "..", "src", "verdicts.ts")
  const PROVIDER = path.resolve(HERE, "..", "src", "opencode-provider.ts")
  const MODELSCONFIG = path.resolve(HERE, "..", "src", "models-config.ts")
  const modelsYml = path.join(home, ".omp", "agent", "models.yml")
  mkdirSync(path.dirname(modelsYml), { recursive: true })
  writeFileSync(modelsYml, "# user content must survive\n")

  const realWorker = (index: number) => `
import { noteUsageOrg } from ${JSON.stringify(ROUTING)}
import { markAccountVerdict } from ${JSON.stringify(VERDICTS)}
import { indexTokenOrg } from ${JSON.stringify(PROVIDER)}
import { writeModelsOverride } from ${JSON.stringify(MODELSCONFIG)}
for (let i = 0; i < ${RLOOPS}; i++) {
  noteUsageOrg("org-${index}-" + i, 0.5)
  markAccountVerdict("tok-${index}-" + i, { kind: "funds", message: "x", at: Date.now() }, "vorg-${index}-" + i)
  indexTokenOrg("tok-${index}-" + i, "org-${index}-" + i)
  writeModelsOverride()
}
`
  const kids = Array.from({ length: WORKERS }, (_, index) =>
    spawnSync("bun", ["-e", realWorker(index)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 }),
  )
  for (const [index, kid] of kids.entries()) {
    assert.equal(kid.status, 0, `real worker ${index} failed: ${String(kid.stderr).slice(0, 300)}`)
  }

  const routingState = JSON.parse(readFileSync(path.join(home, ".omp", "agent", "omp-go-routing.json"), "utf8"))
  for (let index = 0; index < WORKERS; index += 1) {
    for (let i = 0; i < RLOOPS; i += 1) {
      assert.ok(routingState[`org-${index}-${i}`], `lost routing state org-${index}-${i}`)
    }
  }
  const verdictsState = JSON.parse(readFileSync(path.join(home, ".omp", "agent", "omp-go-verdicts.json"), "utf8"))
  for (let index = 0; index < WORKERS; index += 1) {
    for (let i = 0; i < RLOOPS; i += 1) {
      assert.ok(verdictsState[`vorg-${index}-${i}`], `lost verdict vorg-${index}-${i}`)
    }
  }
  const orgs = JSON.parse(readFileSync(path.join(home, ".omp", "agent", "omp-go-orgs.json"), "utf8"))
  assert.ok(Object.keys(orgs).length > 0, "org index lost entirely")
  const models = readFileSync(modelsYml, "utf8")
  assert.equal(models.split("omp-go managed block (do not edit)").length - 1, 1, "managed block duplicated")
  assert.ok(models.includes("# user content must survive"), "user models.yml content dropped")
}

console.log("STATE-SIDEKAR OK: concurrent real writers lose nothing; models.yml block unique, user content intact")
