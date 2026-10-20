// Read-only: shows the on-chain Reg-Gate status and whether each demo token
// would let a transfer through right now. No key, no gas.
//
//   bun deploy/status.ts

import { encodeFunctionData, decodeErrorResult, type Address } from 'viem'
import { assertSepolia, CATEGORIES, clients, etherscan, loadArtifact, loadDeployment, STATUS } from './lib'

const dep = loadDeployment()
const { publicClient } = clients(false)
await assertSepolia(publicClient)

const gateAbi = loadArtifact('RegGateStatus').abi
const tokenAbi = loadArtifact('GatedToken').abi
const gate = dep.regGateStatus.address

const lastAsOf = (await publicClient.readContract({ address: gate, abi: gateAbi, functionName: 'lastAsOf' })) as bigint
console.log(`RegGateStatus ${gate}`)
console.log(`  ${etherscan('address', gate)}`)
console.log(
	lastAsOf === 0n
		? '  No report received yet (every category reads BLOCK until one arrives).'
		: `  Last report: ${new Date(Number(lastAsOf) * 1000).toISOString()}`,
)

for (let i = 0; i < CATEGORIES.length; i++) {
	const eff = Number(await publicClient.readContract({ address: gate, abi: gateAbi, functionName: 'statusOf', args: [i] }))
	const [reported, doc] = (await publicClient.readContract({
		address: gate,
		abi: gateAbi,
		functionName: 'reportedStatus',
		args: [i],
	})) as [number, `0x${string}`]
	const [latched, , unreviewed] = (await publicClient.readContract({ address: gate, abi: gateAbi, functionName: 'latchInfo', args: [i] })) as [boolean, string, bigint]
	const docNum = Buffer.from(doc.slice(2), 'hex').toString('utf-8').replace(/\0+$/, '')
	console.log(
		`  ${CATEGORIES[i].padEnd(22)} ${STATUS[eff].padEnd(6)}${latched ? ` (latched, ${unreviewed} unreviewed)` : ''}${docNum ? `  ${docNum}` : ''}${lastAsOf && eff !== Number(reported) ? `  [reported ${STATUS[Number(reported)]}]` : ''}`,
	)
}

// Simulate a 1-token transfer from the deployer on each demo token (eth_call, free).
console.log('\nDemo tokens (simulated 1-token transfer from the deployer):')
for (const t of dep.tokens) {
	try {
		await publicClient.call({
			account: dep.deployer as Address,
			to: t.address,
			data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: ['0x000000000000000000000000000000000000bEEF', 10n ** 18n] }),
		})
		console.log(`  ${t.symbol} (${t.category}, ${t.strict ? 'strict' : 'lenient'}): ALLOWED`)
	} catch (e: any) {
		const data = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data
		let why = 'reverted'
		try {
			if (data) {
				const d = decodeErrorResult({ abi: tokenAbi, data })
				why = d.errorName === 'TransferBlockedByRegGate' ? `${d.errorName} (status ${STATUS[Number((d.args as any)[1])]})` : d.errorName
			}
		} catch {}
		console.log(`  ${t.symbol} (${t.category}, ${t.strict ? 'strict' : 'lenient'}): BLOCKED  ${why}`)
	}
}
