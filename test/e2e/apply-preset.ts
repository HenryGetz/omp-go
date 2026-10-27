// Applies the user's `go` preset through ompreset's OWN code path - the exact
// functions `/go` runs (parse presets.yml -> normalizePreset -> updateAgentConfigFile).
// The only part not exercised headlessly is `pi.setModel`, which is the session's
// model selection: the TUI turns in tui-preset-go.mjs reproduce its effect by
// routing on the preset's roles (modelRoles.default).
//
// Run: bun test/e2e/apply-preset.ts go

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Plugin location is runtime-selected (OMP_PLUGIN_DIR or the user's home), so these
// specifiers cannot be static imports.
const pluginDir = process.env.OMP_PLUGIN_DIR ?? path.join(homedir(), ".omp", "plugins")

const { default: yaml } = await import(pathToFileURL(path.join(pluginDir, "node_modules/yaml/dist/index.js")).href)
const { normalizePreset } = await import(pathToFileURL(path.join(pluginDir, "node_modules/ompreset/src/config.ts")).href)
const { updateAgentConfigFile } = await import(pathToFileURL(path.join(pluginDir, "node_modules/ompreset/src/applicator.ts")).href)

const name = process.argv[2] ?? "go"
const presetsFile = path.join(homedir(), ".omp", "agent", "presets.yml")
const cfgPath = path.join(homedir(), ".omp", "agent", "config.yml")
const parsed = yaml.parse(readFileSync(presetsFile, "utf8")) as { presets?: Record<string, unknown> }
const raw = parsed.presets?.[name]
if (!raw) {
  console.error(`preset "${name}" not found in ${presetsFile}`)
  process.exit(1)
}
const preset = normalizePreset(name, raw as never)
updateAgentConfigFile(cfgPath, preset)
console.log(JSON.stringify({ applied: preset.name, model: preset.model, roles: preset.roles, cycleOrder: preset.cycleOrder }))
