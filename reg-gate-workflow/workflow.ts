// Reg-Gate CRE workflow.
//
// Two triggers run the same check:
//   - a cron schedule (the heartbeat), and
//   - a LatchCleared event from RegGateStatus: when a human reviewer clears a BLOCK
//     on-chain, the workflow re-verifies against the Federal Register right away
//     instead of waiting up to one cron interval.
//
// Each check:
//   1. Each DON node makes two Federal Register queries over a fixed, finished date
//      window (documents published in it, and final rules taking effect in it) and
//      classifies them (regGate.ts, deterministic).
//   2. Nodes must return byte-identical results (identical consensus). Any
//      disagreement fails the run, nothing is written, and the contract's
//      staleness rule turns that silence into BLOCK.
//   3. For each target chain (the primary plus any mirrors), the workflow reads what
//      RegGateStatus already holds at the last finalized block. If nothing changed and
//      the heartbeat is not due, it skips the write. Otherwise the agreed result is
//      signed into a report bound to that chain's ID and written there.
//
// Flags regulatory publications for human review. Not legal advice.

import {
	bytesToHex,
	consensusIdenticalAggregation,
	type CronPayload,
	cre,
	type EVMLog,
	getNetwork,
	type HTTPSendRequester,
	encodeCallMsg,
	LAST_FINALIZED_BLOCK_NUMBER,
	logTriggerConfig,
	prepareReportRequest,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	parseAbi,
	toEventSelector,
} from 'viem'
import { z } from 'zod'
import {
	buildEffectiveQueryUrl,
	buildQueryUrl,
	CATEGORIES,
	classify,
	computeWindow,
	deserializeResult,
	encodeReport,
	type GateResult,
	type OnChainState,
	parseFederalRegisterResponse,
	serializeResult,
	summarize,
	writeDecision,
} from './regGate'

const FR_PREFIX = 'https://www.federalregister.gov/api/v1/'

/** RegGateStatus emits this when the reviewer clears a latched BLOCK. */
export const LATCH_CLEARED_SIGNATURE = 'LatchCleared(uint8,bytes32,address)'
export const LATCH_CLEARED_TOPIC: Hex = toEventSelector(LATCH_CLEARED_SIGNATURE)

const receiverSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, 'receiverAddress must be a 20-byte hex address')
	.refine((a) => !/^0x0{40}$/.test(a), 'receiverAddress must not be the zero address')
const gasLimitSchema = z.string().regex(/^[1-9][0-9]*$/, 'gasLimit must be a positive integer string')

/** Another chain that receives the same status, with its own contract and replay guard. */
const mirrorSchema = z
	.object({
		chainSelectorName: z.string().min(1),
		isTestnet: z.boolean(),
		receiverAddress: receiverSchema,
		gasLimit: gasLimitSchema,
	})
	.strict()

export const DEFAULT_HEARTBEAT_HOURS = 24

export const configSchema = z
	.object({
		schedule: z.string().min(1),
		frBaseUrl: z
			.string()
			.refine((u) => u.startsWith(FR_PREFIX), `frBaseUrl must start with ${FR_PREFIX}`),
		lookbackDays: z.number().int().min(1).max(90),
		perPage: z.number().int().min(1).max(100),
		// Primary chain: written every run (unless unchanged) and watched for LatchCleared.
		chainSelectorName: z.string().min(1),
		isTestnet: z.boolean(),
		receiverAddress: receiverSchema,
		gasLimit: gasLimitSchema,
		// Rewrite an unchanged status at least this often (capped at half the contract's maxAge).
		heartbeatHours: z.number().int().min(1).max(168).optional(),
		mirrors: z.array(mirrorSchema).max(4).optional(),
	})
	.strict()
	.refine(
		(c) => {
			const names = [c.chainSelectorName, ...(c.mirrors ?? []).map((m) => m.chainSelectorName)]
			return new Set(names).size === names.length
		},
		{ message: 'each chain may appear only once (primary and mirrors)' },
	)

export type Config = z.infer<typeof configSchema>

/** One chain the status is written to. */
export interface Target {
	chainSelectorName: string
	isTestnet: boolean
	receiverAddress: string
	gasLimit: string
}

export const targetsOf = (c: Config): Target[] => [
	{
		chainSelectorName: c.chainSelectorName,
		isTestnet: c.isTestnet,
		receiverAddress: c.receiverAddress,
		gasLimit: c.gasLimit,
	},
	...(c.mirrors ?? []),
]

// The RegGateStatus views the heartbeat reads. CI checks these against the compiled ABI.
export const STATUS_READ_ABI = parseAbi([
	'function lastAsOf() view returns (uint64)',
	'function maxAge() view returns (uint64)',
	'function reportedStatus(uint8 category) view returns (uint8 status, bytes32 triggerDoc)',
])
// Reads come from the zero address: views need no sender, and nothing is signed.
const READ_FROM: Address = '0x0000000000000000000000000000000000000000'

type FetchArgs = { url: string; effectiveUrl: string; start: string; end: string }

const fetchBody = (sendRequester: HTTPSendRequester, url: string): string => {
	const response = sendRequester.sendRequest({ method: 'GET', url }).result()
	if (response.statusCode !== 200) {
		throw new Error(`Federal Register request failed with status ${response.statusCode}`)
	}
	return Buffer.from(response.body).toString('utf-8')
}

/** Runs on each node. Throws on anything unexpected; the DON then writes nothing. */
export const fetchAndClassify = (sendRequester: HTTPSendRequester, args: FetchArgs): string => {
	// Both queries must succeed. Half a picture is not reported as a whole one.
	const published = parseFederalRegisterResponse(fetchBody(sendRequester, args.url))
	const takingEffect = parseFederalRegisterResponse(fetchBody(sendRequester, args.effectiveUrl))
	return serializeResult(classify(published, args.start, args.end, takingEffect))
}

const resolveNetwork = (t: Pick<Target, 'chainSelectorName' | 'isTestnet'>) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: t.chainSelectorName,
		isTestnet: t.isTestnet,
	})
	if (!network) throw new Error(`Network not found for chain selector name: ${t.chainSelectorName}`)
	return network
}

type EvmClient = InstanceType<typeof cre.capabilities.EVMClient>

/** One view call at the last finalized block. Throws on failure; the caller decides. */
const readView = <const F extends 'lastAsOf' | 'maxAge' | 'reportedStatus'>(
	runtime: Runtime<Config>,
	evm: EvmClient,
	to: Address,
	functionName: F,
	args: readonly unknown[],
) => {
	const data = encodeFunctionData({ abi: STATUS_READ_ABI, functionName, args } as any)
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({ from: READ_FROM, to, data }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()
	return decodeFunctionResult({ abi: STATUS_READ_ABI, functionName, data: bytesToHex(reply.data) } as any)
}

/**
 * What the contract on this chain holds now. Returns null on ANY failure: the
 * heartbeat treats an unreadable chain as "write", never as "unchanged".
 * Finalized, not latest: a report still in an unfinalized block reads as older,
 * which can only cause an extra write, never a skipped one.
 */
export const readOnChain = (runtime: Runtime<Config>, evm: EvmClient, receiver: Address): OnChainState | null => {
	try {
		const lastAsOf = readView(runtime, evm, receiver, 'lastAsOf', []) as bigint
		const maxAge = readView(runtime, evm, receiver, 'maxAge', []) as bigint
		const statuses: number[] = []
		const triggerDocs: Hex[] = []
		for (let i = 0; i < CATEGORIES.length; i++) {
			const [status, doc] = readView(runtime, evm, receiver, 'reportedStatus', [i]) as readonly [number, Hex]
			statuses.push(Number(status))
			triggerDocs.push(doc)
		}
		return { lastAsOf, maxAge, statuses, triggerDocs }
	} catch (e) {
		runtime.log(`Reg-Gate: on-chain read failed (${(e as Error).message}); will write`)
		return null
	}
}

type ChainOutcome = { chain: string; outcome: 'written' | 'skipped' | 'failed'; detail: string }

/** Read, decide, and (if needed) sign and write one chain's report. Never throws. */
const deliver = (
	runtime: Runtime<Config>,
	target: Target,
	result: GateResult,
	asOf: number,
	heartbeatSeconds: bigint,
): ChainOutcome => {
	const chain = target.chainSelectorName
	try {
		const network = resolveNetwork(target)
		const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
		const receiver = target.receiverAddress as Address

		const decision = writeDecision(readOnChain(runtime, evm, receiver), result, BigInt(asOf), heartbeatSeconds)
		if (!decision.write) {
			runtime.log(`Reg-Gate: ${chain}: ${decision.reason}; no write`)
			return { chain, outcome: 'skipped', detail: decision.reason }
		}

		// chainId in the payload binds each report to its own chain (cross-chain replay guard).
		const report = encodeReport(BigInt(network.chainId), BigInt(asOf), result)
		const signed = runtime.report(prepareReportRequest(report)).result()
		const resp = evm
			.writeReport(runtime, { receiver, report: signed, gasConfig: { gasLimit: target.gasLimit } })
			.result()
		if (resp.txStatus !== TxStatus.SUCCESS) {
			return { chain, outcome: 'failed', detail: resp.errorMessage || String(resp.txStatus) }
		}
		const tx = bytesToHex(resp.txHash || new Uint8Array(32))
		runtime.log(`Reg-Gate: ${chain}: ${decision.reason}; report written, txHash ${tx}`)
		return { chain, outcome: 'written', detail: tx }
	} catch (e) {
		return { chain, outcome: 'failed', detail: (e as Error).message }
	}
}

/** The check both triggers run: fetch, classify, agree, sign, write. */
export const runCheck = (runtime: Runtime<Config>): string => {
	const config = runtime.config
	// Stamp the report with DON time (consensus, identical on every node), not the
	// cron schedule. The schedule can be ahead of real time, e.g. a manually fired
	// simulation reports the NEXT slot, and the contract rightly rejects a report
	// from the future (FutureReport). Found on the first Sepolia broadcast, 2026-10-19.
	const asOf = Math.floor(runtime.now().getTime() / 1000)
	const window = computeWindow(asOf, config.lookbackDays)
	const url = buildQueryUrl(config.frBaseUrl, window, config.perPage)
	const effectiveUrl = buildEffectiveQueryUrl(config.frBaseUrl, window, config.perPage)
	runtime.log(`Reg-Gate: querying Federal Register ${window.start}..${window.end} (published, taking effect)`)

	const http = new cre.capabilities.HTTPClient()
	const agreed = http
		.sendRequest(runtime, fetchAndClassify, consensusIdenticalAggregation<string>())({
			url,
			effectiveUrl,
			start: window.start,
			end: window.end,
		})
		.result()

	const result = deserializeResult(agreed)
	runtime.log(`Reg-Gate: ${summarize(result)}`)

	// Same agreed result to every chain. Chains are independent: one failing does not
	// stop the others, but the run still fails so the miss is visible, and that
	// chain's own staleness rule turns continued silence into BLOCK.
	const heartbeatSeconds = BigInt((config.heartbeatHours ?? DEFAULT_HEARTBEAT_HOURS) * 3600)
	const outcomes = targetsOf(config).map((t) => deliver(runtime, t, result, asOf, heartbeatSeconds))

	const failed = outcomes.filter((o) => o.outcome === 'failed')
	if (failed.length > 0) {
		throw new Error(`Failed to write report: ${failed.map((o) => `${o.chain}: ${o.detail}`).join('; ')}`)
	}
	return `${summarize(result)} | ${outcomes.map((o) => `${o.chain}=${o.outcome}`).join(' ')}`
}

export const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
	if (!payload.scheduledExecutionTime) throw new Error('Scheduled execution time is required')
	return runCheck(runtime)
}

/**
 * A reviewer cleared a latched BLOCK. The clear was judged against the last report,
 * which can be up to one cron interval old, so re-verify against the Federal Register
 * now. If a new blocking document has landed since, it latches again immediately
 * instead of leaving transfers open until the next scheduled run.
 *
 * The trigger filter already limits logs to our contract and event. The handler checks
 * again anyway and refuses anything else (fail closed: a refused run writes nothing).
 */
export const onLatchCleared = (runtime: Runtime<Config>, log: EVMLog): string => {
	const emitter = bytesToHex(log.address).toLowerCase()
	if (emitter !== runtime.config.receiverAddress.toLowerCase()) {
		throw new Error(`Refusing log from unexpected contract ${emitter}`)
	}
	const topic0 = log.topics[0] ? bytesToHex(log.topics[0]).toLowerCase() : 'none'
	if (topic0 !== LATCH_CLEARED_TOPIC) throw new Error(`Refusing unexpected event ${topic0}`)
	if (log.removed) throw new Error('Refusing a log that was removed by a reorg')

	const category = log.topics[1] ? Number(BigInt(bytesToHex(log.topics[1]))) : -1
	const name = CATEGORIES[category] ?? `category ${category}`
	runtime.log(`Reg-Gate: reviewer cleared the latch on ${name}; re-verifying now`)
	return runCheck(runtime)
}

export function initWorkflow(config: Config) {
	// Fail at startup, not mid-run, on a bad chain name (primary or mirror).
	for (const t of targetsOf(config)) resolveNetwork(t)
	const network = resolveNetwork(config)
	const cron = new cre.capabilities.CronCapability()
	const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
	return [
		// Order matters for `cre workflow simulate --trigger-index`: 0 = cron, 1 = LatchCleared.
		cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
		cre.handler(
			evm.logTrigger(
				logTriggerConfig({
					addresses: [config.receiverAddress as Hex],
					topics: [[LATCH_CLEARED_TOPIC]],
					confidence: 'SAFE',
				}),
			),
			onLatchCleared,
		),
	]
}
