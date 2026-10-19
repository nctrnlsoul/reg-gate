// Diagnoses a broadcast: did the report reach RegGateStatus, and if not, why?
// Read-only. No key, no gas.
//
//   bun deploy/diagnose.ts <txHash>

import { decodeAbiParameters, decodeErrorResult, decodeEventLog, decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem'
import { assertSepolia, clients, loadArtifact, loadDeployment, STATUS } from './lib'

const txHash = process.argv[2] as Hex
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) throw new Error('usage: bun deploy/diagnose.ts <txHash>')

const dep = loadDeployment()
const { publicClient } = clients(false)
await assertSepolia(publicClient)
const gateAbi = loadArtifact('RegGateStatus').abi
const gate = dep.regGateStatus.address.toLowerCase()

const tx = await publicClient.getTransaction({ hash: txHash })
const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
console.log(`tx status: ${receipt.status}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed} of ${tx.gas}`)
console.log(`to: ${tx.to}  (expected forwarder ${dep.forwarder})`)

console.log(`\nlogs (${receipt.logs.length}):`)
let gateEmitted = false
for (const log of receipt.logs) {
	const addr = log.address.toLowerCase()
	if (addr === gate) {
		gateEmitted = true
		try {
			const ev = decodeEventLog({ abi: gateAbi, data: log.data, topics: log.topics })
			console.log(`  RegGateStatus.${ev.eventName}`, JSON.stringify(ev.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
		} catch {
			console.log(`  RegGateStatus: undecoded log ${log.topics[0]}`)
		}
	} else {
		console.log(`  ${log.address} topic0=${log.topics[0]} data=${log.data.slice(0, 200)}${log.data.length > 200 ? '...' : ''}`)
		// KeystoneForwarder ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)
		if (log.topics.length === 4 && log.data.length === 66) {
			console.log(`    receiver=0x${log.topics[1]!.slice(26)} result=${BigInt(log.data) === 1n}`)
		}
	}
}
console.log(gateEmitted ? '\nRegGateStatus emitted events: report ACCEPTED.' : '\nRegGateStatus emitted nothing: report did NOT land.')

const last = (await publicClient.readContract({ address: dep.regGateStatus.address, abi: gateAbi, functionName: 'lastAsOf' })) as bigint
console.log(`lastAsOf now: ${last}${last ? ` (${new Date(Number(last) * 1000).toISOString()})` : ' (no report stored)'}`)

// Replay what the forwarder delivered, to get the exact revert reason.
const fwdAbi = parseAbi(['function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)'])
try {
	const { args } = decodeFunctionData({ abi: fwdAbi, data: tx.input })
	const [receiver, rawReport] = args as [Hex, Hex]
	console.log(`\nforwarder.report(receiver=${receiver}, rawReport ${(rawReport.length - 2) / 2} bytes)`)
	const raw = rawReport.slice(2)
	// rawReport = version(1) execId(32) ts(4) donId(4) donCfg(4) | workflowCid(32) name(10) owner(20) reportId(2) | payload
	const metadata = `0x${raw.slice(45 * 2, 109 * 2)}` as Hex
	const payload = `0x${raw.slice(109 * 2)}` as Hex
	console.log(`metadata owner: 0x${raw.slice(87 * 2, 107 * 2)}`)
	try {
		const [chainId, asOf, statuses, docs] = decodeAbiParameters(
			[{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint8[4]' }, { type: 'bytes32[4]' }],
			payload,
		)
		const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
		console.log(`payload: chainId=${chainId} asOf=${asOf} (${new Date(Number(asOf) * 1000).toISOString()}) blockTime=${block.timestamp} (${new Date(Number(block.timestamp) * 1000).toISOString()})`)
		console.log(`payload statuses: ${[...statuses].map((s) => STATUS[Number(s)]).join(',')}`)
		console.log(`payload docs: ${[...docs].map((d) => Buffer.from(d.slice(2), 'hex').toString().replace(/\0+$/, '') || '-').join(',')}`)
	} catch (e: any) {
		console.log(`payload did not decode as (uint256,uint64,uint8[4],bytes32[4]): ${e.shortMessage ?? e.message}`)
	}
	try {
		await publicClient.call({
			account: dep.forwarder,
			to: dep.regGateStatus.address,
			data: encodeFunctionData({ abi: gateAbi, functionName: 'onReport', args: [metadata, payload] }),
			blockNumber: receipt.blockNumber - 1n,
		})
		console.log('replay at the block before: onReport would SUCCEED')
	} catch (e: any) {
		const data = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data
		let why = e.shortMessage ?? e.message
		try {
			if (data) {
				const d = decodeErrorResult({ abi: gateAbi, data })
				why = `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`
			}
		} catch {}
		console.log(`replay at the block before: onReport REVERTS with ${why}`)
	}
} catch (e: any) {
	console.log(`\ncould not decode tx input as forwarder.report: selector ${tx.input.slice(0, 10)} (${e.shortMessage ?? e.message})`)
}
