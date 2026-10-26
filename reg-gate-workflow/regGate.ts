// Reg-Gate: the parts of the workflow logic that need viem (ABI encoding, bytes32).
// Everything pure lives in rules.ts and is re-exported here, so callers import one module.

import { encodeAbiParameters, stringToHex, type Hex } from 'viem'
import { CATEGORIES, type GateResult } from './rules'

export * from './rules'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

/** A Federal Register document number as the contract stores it. '' is all zeros. */
export const docToBytes32 = (d: string): Hex => (d === '' ? ZERO32 : stringToHex(d, { size: 32 }))

/** Every blocking document, flattened in category order, as the contract stores it. */
export function flattenBlockDocs(r: GateResult): { docs: Hex[]; cats: number[] } {
	const docs: Hex[] = []
	const cats: number[] = []
	r.blockDocs.forEach((list, i) => {
		for (const d of list) {
			docs.push(docToBytes32(d))
			cats.push(i)
		}
	})
	return { docs, cats }
}

export const REPORT_PARAMS = [
	{ type: 'uint256' },
	{ type: 'uint64' },
	{ type: 'uint8[4]' },
	{ type: 'bytes32[4]' },
	{ type: 'bytes32[]' },
	{ type: 'uint8[]' },
] as const

/**
 * ABI payload for RegGateStatus.sol:
 *   (uint256 chainId, uint64 asOf, uint8[4] statuses, bytes32[4] triggerDocs,
 *    bytes32[] blockDocs, uint8[] blockCategories)
 * chainId and asOf defend against cross-chain and same-chain replay. blockDocs lists
 * every document at BLOCK, so the contract can require a human review of each one.
 */
export function encodeReport(chainId: bigint, asOf: bigint, r: GateResult): Hex {
	const { docs, cats } = flattenBlockDocs(r)
	return encodeAbiParameters(REPORT_PARAMS, [
		chainId,
		asOf,
		r.statuses as unknown as readonly [number, number, number, number],
		r.triggerDocs.map(docToBytes32) as unknown as readonly [Hex, Hex, Hex, Hex],
		docs,
		cats,
	])
}

/** What a chain's RegGateStatus holds (its snapshot() view) at one block. */
export interface OnChainState {
	lastAsOf: bigint
	maxAge: bigint
	statuses: number[] // raw reported statuses, index matches CATEGORIES
	triggerDocs: Hex[] // bytes32, index matches CATEGORIES
	blockDocs: Hex[] // every listed blocking document, in category order
	blockCats: number[]
}

export interface WriteDecision {
	write: boolean
	reason: string
}

/**
 * Heartbeat rule: skip the write only when we are sure it changes nothing.
 * Every doubt resolves to writing, because a skipped write ages the on-chain
 * report toward stale (BLOCK) while a redundant one only costs gas.
 *
 *   - read failed or returned a bad shape         -> write
 *   - no report on-chain yet                      -> write
 *   - any status, trigger or blocking document differs -> write
 *   - last report is at least min(heartbeat, maxAge / 4) old -> write
 *   - otherwise                                   -> skip
 *
 * The maxAge / 4 cap means a misconfigured heartbeat can never let a chain go stale
 * between runs that skip, even with a run's clock a little late or one run failing,
 * as long as maxAge is at least twice the cron interval.
 */
export function writeDecision(
	onChain: OnChainState | null,
	r: GateResult,
	asOf: bigint,
	heartbeatSeconds: bigint,
): WriteDecision {
	if (onChain === null) return { write: true, reason: 'on-chain read failed' }
	const n = CATEGORIES.length
	if (onChain.statuses.length !== n || onChain.triggerDocs.length !== n) {
		return { write: true, reason: 'on-chain read had an unexpected shape' }
	}
	if (onChain.lastAsOf === 0n) return { write: true, reason: 'no report on-chain yet' }
	for (let i = 0; i < n; i++) {
		if (onChain.statuses[i] !== r.statuses[i] || onChain.triggerDocs[i].toLowerCase() !== docToBytes32(r.triggerDocs[i])) {
			return { write: true, reason: `${CATEGORIES[i]} changed` }
		}
	}
	const want = flattenBlockDocs(r)
	if (
		onChain.blockDocs.length !== want.docs.length ||
		onChain.blockCats.length !== want.cats.length ||
		want.docs.some((d, j) => onChain.blockDocs[j].toLowerCase() !== d || onChain.blockCats[j] !== want.cats[j])
	) {
		return { write: true, reason: 'blocking documents changed' }
	}
	const quarterMaxAge = onChain.maxAge / 4n
	const limit = heartbeatSeconds < quarterMaxAge ? heartbeatSeconds : quarterMaxAge
	const age = asOf - onChain.lastAsOf
	if (age >= limit) return { write: true, reason: `heartbeat due (last report ${age}s old, limit ${limit}s)` }
	return { write: false, reason: `unchanged, last report ${age}s old (heartbeat at ${limit}s)` }
}
