// Reg-Gate CRE workflow.
//
// On a cron schedule:
//   1. Each DON node fetches U.S. Federal Register publications for a fixed,
//      finished date window and classifies them (regGate.ts, deterministic).
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
	getNetwork,
	type HTTPSendRequester,
	prepareReportRequest,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import type { Address } from 'viem'
import { z } from 'zod'
import {
	buildQueryUrl,
	classify,
	computeWindow,
	deserializeResult,
	encodeReport,
	parseFederalRegisterResponse,
	serializeResult,
	summarize,
} from './regGate'

const FR_PREFIX = 'https://www.federalregister.gov/api/v1/'

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

type FetchArgs = { url: string; start: string; end: string }

/** Runs on each node. Throws on anything unexpected; the DON then writes nothing. */
export const fetchAndClassify = (sendRequester: HTTPSendRequester, args: FetchArgs): string => {
	const response = sendRequester.sendRequest({ method: 'GET', url: args.url }).result()
	if (response.statusCode !== 200) {
		throw new Error(`Federal Register request failed with status ${response.statusCode}`)
	}
	const body = Buffer.from(response.body).toString('utf-8')
	return serializeResult(classify(parseFederalRegisterResponse(body), args.start, args.end))
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

export const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
	const scheduled = payload.scheduledExecutionTime
	if (!scheduled) throw new Error('Scheduled execution time is required')

	const config = runtime.config
	// Stamp the report with DON time (consensus, identical on every node), not the
	// cron schedule. The schedule can be ahead of real time, e.g. a manually fired
	// simulation reports the NEXT slot, and the contract rightly rejects a report
	// from the future (FutureReport). Found on the first Sepolia broadcast, 2026-10-19.
	const asOf = Math.floor(runtime.now().getTime() / 1000)
	const window = computeWindow(asOf, config.lookbackDays)
	const url = buildQueryUrl(config.frBaseUrl, window, config.perPage)
	runtime.log(`Reg-Gate: querying Federal Register ${window.start}..${window.end}`)

	const http = new cre.capabilities.HTTPClient()
	const agreed = http
		.sendRequest(runtime, fetchAndClassify, consensusIdenticalAggregation<string>())({
			url,
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

export function initWorkflow(config: Config) {
	resolveNetwork(config) // fail at startup, not mid-run, on a bad chain name
	const cron = new cre.capabilities.CronCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
