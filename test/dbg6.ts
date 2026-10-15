process.env.OMP_ORG_DEBUG = "/tmp/dbg6.ndjson"
import { providerOverride } from "../src/console-config.ts"
try {
  const o = providerOverride("org_01M4SDCRSJX3GFZ1F1047Q2W9K", "opencode-go")
  console.log("override ok:", JSON.stringify(o).slice(0, 140))
} catch (e) {
  console.log("override THREW:", String(e).slice(0, 200))
}
