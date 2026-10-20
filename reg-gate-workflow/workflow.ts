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
//   3. The agreed result is signed into a report and written to RegGateStatus.sol.
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
	logTriggerConfig,
	prepareReportRequest,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, type Hex, toEventSelector } from 'viem'
import { z } from 'zod'
import {
	buildEffectiveQueryUrl,
	buildQueryUrl,
	CATEGORIES,
	classify,
	computeWindow,
	deserializeResult,
	encodeReport,
	parseFederalRegisterResponse,
	serializeResult,
	summarize,
} from './regGate'

const FR_PREFIX = 'https://www.federalregister.gov/api/v1/'

/** RegGateStatus emits this when the reviewer clears a latched BLOCK. */
export const LATCH_CLEARED_SIGNATURE = 'LatchCleared(uint8,bytes32,address)'
export const LATCH_CLEARED_TOPIC: Hex = toEventSelector(LATCH_CLEARED_SIGNATURE)

export const configSchema = z
	.object({
		schedule: z.string().min(1),
		frBaseUrl: z
			.string()
			.refine((u) => u.startsWith(FR_PREFIX), `frBaseUrl must start with ${FR_PREFIX}`),
		lookbackDays: z.number().int().min(1).max(90),
		perPage: z.number().int().min(1).max(100),
		chainSelectorName: z.string().min(1),
		isTestnet: z.boolean(),
		receiverAddress: z
			.string()
			.regex(/^0x[0-9a-fA-F]{40}$/, 'receiverAddress must be a 20-byte hex address')
			.refine((a) => !/^0x0{40}$/.test(a), 'receiverAddress must not be the zero address'),
		gasLimit: z.string().regex(/^[1-9][0-9]*$/, 'gasLimit must be a positive integer string'),
	})
	.strict()

export type Config = z.infer<typeof configSchema>

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

const resolveNetwork = (config: Config) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.chainSelectorName,
		isTestnet: config.isTestnet,
	})
	if (!network) throw new Error(`Network not found for chain selector name: ${config.chainSelectorName}`)
	return network
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

	const network = resolveNetwork(config)
	const report = encodeReport(BigInt(network.chainId), BigInt(asOf), result)

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
	const signed = runtime.report(prepareReportRequest(report)).result()
	const resp = evmClient
		.writeReport(runtime, {
			receiver: config.receiverAddress as Address,
			report: signed,
			gasConfig: { gasLimit: config.gasLimit },
		})
		.result()

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`Failed to write report: ${resp.errorMessage || resp.txStatus}`)
	}
	runtime.log(`Reg-Gate: report written, txHash ${bytesToHex(resp.txHash || new Uint8Array(32))}`)

	return summarize(result)
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
	const network = resolveNetwork(config) // fail at startup, not mid-run, on a bad chain name
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
