// Builds docs/rules.js from rules.ts, so the status page explains each status with
// the exact rules the DON runs. CI rebuilds it and fails if the committed file differs.
//
//   bun run build:page

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_JS = join(import.meta.dir, '..', 'docs', 'rules.js')

const HEADER = `// GENERATED from reg-gate-workflow/rules.ts by build-page.ts. Do not edit.
// The same classifier every Chainlink DON node runs, loaded by the status page
// to explain each status. Rebuild with: bun run build:page (in reg-gate-workflow/)
`

export async function buildRulesJs(): Promise<string> {
	const out = await Bun.build({ entrypoints: [join(import.meta.dir, 'rules.ts')], format: 'esm', target: 'browser' })
	if (!out.success) throw new Error(out.logs.map(String).join('\n'))
	return HEADER + (await out.outputs[0].text())
}

if (import.meta.main) {
	writeFileSync(RULES_JS, await buildRulesJs())
	console.log(`wrote ${RULES_JS}`)
}
