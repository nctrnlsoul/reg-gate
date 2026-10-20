// End-to-end: the real onCronTrigger, with the HTTP and EVM capabilities mocked.
// Proves the full path (query -> fetch -> classify -> consensus -> report -> write)
// and that every failure mode writes nothing on-chain.

import { describe, expect } from 'bun:test'
import { getNetwork, TxStatus } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, decodeAbiParameters, hexToBytes, hexToString, pad, toHex, type Hex } from 'viem'
import { CATEGORIES, Status } from './regGate'
import { type Config, LATCH_CLEARED_TOPIC, onCronTrigger, onLatchCleared } from './workflow'

const config: Config = {
	schedule: '0 0 */6 * * *',
	frBaseUrl: 'https://www.federalregister.gov/api/v1/documents.json',
	lookbackDays: 14,
	perPage: 50,
	chainSelectorName: 'ethereum-testnet-sepolia',
	isTestnet: true,
	receiverAddress: '0x000000000000000000000000000000000000dEaD',
	gasLimit: '1000000',
}

const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true })!
// DON time for the run. The window is 2026-10-05..2026-10-18.
const NOW = Date.UTC(2026, 9, 19, 3, 4, 12) / 1000
const SCHEDULED = NOW // the cron slot; one test below moves it ahead of NOW
const payload = { scheduledExecutionTime: { seconds: BigInt(SCHEDULED), nanos: 0 } } as any
const donTime = { timeProvider: () => NOW * 1000 }
const idx = (c: (typeof CATEGORIES)[number]) => CATEGORIES.indexOf(c)

// Shapes copied from live Federal Register documents (2026-10-18 simulation, rechecked 2026-10-20).
const LIVE_RESULTS = {
	count: 4,
	results: [
		{
			// An exchange's own rule filing, published by the SEC for comment. Informational.
			document_number: '2026-21128',
			title:
				'Self-Regulatory Organizations; Cboe BZX Exchange, Inc.; Notice of Filing of a Proposed Rule Change To List and Trade Options on Commodity-Based Trusts Holding Multiple Crypto Assets',
			type: 'Notice',
			publication_date: '2026-10-16',
			effective_on: null,
			abstract: null,
			agencies: [{ name: 'Securities and Exchange Commission', slug: 'securities-and-exchange-commission' }],
		},
		{
			document_number: '2026-20466',
			title: 'Adviser and Regulated Fund Custody Rules; Crypto Custody Rules',
			type: 'Proposed Rule',
			publication_date: '2026-10-06',
			abstract: 'Proposed crypto custody rules, including for tokenized private funds.',
			agencies: [{ name: 'Securities and Exchange Commission', slug: 'securities-and-exchange-commission' }],
		},
		{
			document_number: '2026-20888',
			title: 'Regulation Crypto Asset Transactions and Regulation Crypto Asset Markets',
			type: 'Proposed Rule',
			publication_date: '2026-10-13',
			abstract: 'Tailored rules for crypto assets under the Commodity Exchange Act.',
			agencies: [{ name: 'Commodity Futures Trading Commission', slug: 'commodity-futures-trading-commission' }],
		},
		{
			// FinCEN withdrawing its own 2020 proposal. Removes an obligation; informational.
			document_number: '2026-20430',
			title: 'Requirements for Certain Transactions Involving Convertible Virtual Currency or Digital Assets; Withdrawal',
			type: 'Proposed Rule',
			publication_date: '2026-10-06',
			abstract: 'FinCEN is withdrawing a notice of proposed rulemaking (NPRM) that proposed requiring banks and money service businesses (MSBs) to submit reports.',
			agencies: [
				{ name: 'Treasury Department', slug: 'treasury-department' },
				{ name: 'Financial Crimes Enforcement Network', slug: 'financial-crimes-enforcement-network' },
			],
		},
	],
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

/** Wire both mocks; returns what the workflow requested and wrote. */
type HttpReply = { status: number; body: string }
const NOTHING_TAKES_EFFECT: HttpReply = { status: 200, body: JSON.stringify({ description: 'x', count: 0 }) }

/**
 * Wire both mocks; returns what the workflow requested and wrote. `http` answers the
 * published-in-window query, `effective` answers the taking-effect-in-window query.
 */
function wire(http: HttpReply, effective: HttpReply = NOTHING_TAKES_EFFECT) {
	const seen = { urls: [] as string[], writes: [] as { receiver: Hex; payload: Hex }[] }
	const httpMock = HttpActionsMock.testInstance()
	httpMock.sendRequest = (req) => {
		seen.urls.push(req.url)
		const reply = req.url.includes('effective_date') ? effective : http
		return { statusCode: reply.status, body: b64(reply.body) }
	}
	const evmMock = EvmMock.testInstance(network.chainSelector.selector)
	evmMock.writeReport = (input) => {
		const raw = input.report?.rawReport ?? new Uint8Array()
		seen.writes.push({
			receiver: bytesToHex(input.receiver),
			payload: bytesToHex(raw.slice(REPORT_METADATA_HEADER_LENGTH)),
		})
		return { txStatus: TxStatus.SUCCESS, txHash: new Uint8Array(32).fill(0xab) }
	}
	return seen
}

const decode = (payloadHex: Hex) =>
	decodeAbiParameters(
		[{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint8[4]' }, { type: 'bytes32[4]' }],
		payloadHex,
	)

describe('onCronTrigger end to end', () => {
	test('live-shaped data produces the expected on-chain report', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)

		const summary = onCronTrigger(runtime as any, payload)

		// Two queries over the same window, over https, on the Federal Register only:
		// published in the window, and final rules taking effect in the window.
		expect(seen.urls).toHaveLength(2)
		for (const u of seen.urls) expect(u.startsWith(config.frBaseUrl)).toBe(true)
		expect(seen.urls[0]).toContain('conditions%5Bpublication_date%5D%5Bgte%5D=2026-10-05')
		expect(seen.urls[0]).toContain('conditions%5Bpublication_date%5D%5Blte%5D=2026-10-18')
		expect(seen.urls[1]).toContain('conditions%5Btype%5D%5B%5D=RULE')
		expect(seen.urls[1]).toContain('conditions%5Beffective_date%5D%5Bgte%5D=2026-10-05')
		expect(seen.urls[1]).toContain('conditions%5Beffective_date%5D%5Blte%5D=2026-10-18')

		// Wrote exactly one report, to the configured receiver.
		expect(seen.writes).toHaveLength(1)
		expect(seen.writes[0].receiver.toLowerCase()).toBe(config.receiverAddress.toLowerCase())

		const [chainId, asOf, statuses, docs] = decode(seen.writes[0].payload)
		expect(chainId).toBe(BigInt(network.chainId)) // replay guard: bound to Sepolia
		expect(asOf).toBe(BigInt(NOW)) // replay guard: monotonic DON time
		// AML is OK: the only AML document is a withdrawal. Markets is REVIEW on the CFTC
		// proposal, not on the newer Cboe filing.
		expect([...statuses]).toEqual([Status.OK, Status.REVIEW, Status.REVIEW, Status.OK])
		expect(hexToString(docs[idx('TOKENIZED_SECURITIES')] as Hex, { size: 32 })).toBe('2026-20466') // SEC, not CFTC
		expect(hexToString(docs[idx('DIGITAL_ASSET_MARKETS')] as Hex, { size: 32 })).toBe('2026-20888')
		expect(docs[idx('AML_SANCTIONS')]).toBe(`0x${'00'.repeat(32)}`)
		expect(summary).toContain('STABLECOINS=OK')
		expect(summary).toContain('informational=2')
	})

	test('a final rule taking effect in the window blocks, though it was published months ago', () => {
		const takingEffect = {
			count: 1,
			results: [
				{
					document_number: '2026-15000',
					title: 'GENIUS Act Regulations on Payment Stablecoin Issuance, Offer, and Sale',
					type: 'Rule',
					publication_date: '2026-07-14',
					effective_on: '2026-10-13',
					abstract: 'Treasury is adopting rules implementing section 3 of the GENIUS Act.',
					agencies: [{ name: 'Treasury Department', slug: 'treasury-department' }],
				},
			],
		}
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) }, { status: 200, body: JSON.stringify(takingEffect) })
		const runtime = newTestRuntime(null, donTime, config)
		onCronTrigger(runtime as any, payload)
		const [, , statuses, docs] = decode(seen.writes[0].payload)
		expect(statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
		expect(hexToString(docs[idx('STABLECOINS')] as Hex, { size: 32 })).toBe('2026-15000')
	})

	test('the effective-date query failing writes nothing (no half picture)', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) }, { status: 503, body: JSON.stringify({ count: 0 }) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow('status 503')
		expect(seen.writes).toHaveLength(0)
	})

	test('the effective-date query returning anything but a rule taking effect in the window writes nothing', () => {
		const proposal = { count: 1, results: [LIVE_RESULTS.results[1]] }
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) }, { status: 200, body: JSON.stringify(proposal) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow('not a final rule')
		expect(seen.writes).toHaveLength(0)
	})

	test('report is stamped with DON time, not a cron slot that is still in the future', () => {
		// Regression for the first Sepolia broadcast (2026-10-19): a manually fired
		// simulation carried the NEXT slot (04:00Z) while the chain was at 03:04Z,
		// so RegGateStatus rejected the report with FutureReport.
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)
		const futureSlot = { scheduledExecutionTime: { seconds: BigInt(NOW + 56 * 60), nanos: 0 } } as any
		onCronTrigger(runtime as any, futureSlot)
		const [, asOf] = decode(seen.writes[0].payload)
		expect(asOf).toBe(BigInt(NOW))
	})

	test('HTTP failure writes nothing (contract staleness turns silence into BLOCK)', () => {
		const seen = wire({ status: 503, body: 'Service Unavailable' })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow()
		expect(seen.writes).toHaveLength(0)
	})

	test('error status with a body that parses as "no results" must NOT read as all-OK', () => {
		// The dangerous case: a proxy or cache answers 5xx with valid-looking empty JSON.
		// Only the status check stands between this and a fresh all-OK report.
		const seen = wire({ status: 500, body: JSON.stringify({ count: 0 }) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow('status 500')
		expect(seen.writes).toHaveLength(0)
	})

	test('malformed body writes nothing', () => {
		const seen = wire({ status: 200, body: '<html>rate limited</html>' })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow()
		expect(seen.writes).toHaveLength(0)
	})

	test('a document outside the requested window writes nothing (do not trust the API)', () => {
		const bad = { count: 1, results: [{ ...LIVE_RESULTS.results[0], publication_date: '2026-10-19' }] }
		const seen = wire({ status: 200, body: JSON.stringify(bad) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow()
		expect(seen.writes).toHaveLength(0)
	})

	test('a failed chain write surfaces as an error', () => {
		wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const evmMock = EvmMock.testInstance(network.chainSelector.selector)
		evmMock.writeReport = () => ({ txStatus: TxStatus.REVERTED, errorMessage: 'reverted' })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onCronTrigger(runtime as any, payload)).toThrow('Failed to write report')
	})
})

/** A LatchCleared log as the EVM log trigger delivers it. */
function clearLog(over: Record<string, unknown> = {}) {
	return {
		address: hexToBytes(config.receiverAddress as Hex),
		topics: [
			hexToBytes(LATCH_CLEARED_TOPIC),
			hexToBytes(pad(toHex(idx('DIGITAL_ASSET_MARKETS')), { size: 32 })), // category (indexed)
			hexToBytes(pad('0x00000000000000000000000000000000000000aa', { size: 32 })), // reviewer (indexed)
		],
		data: hexToBytes(pad(toHex('2026-21128'), { size: 32, dir: 'right' })),
		eventSig: hexToBytes(LATCH_CLEARED_TOPIC),
		txHash: new Uint8Array(32).fill(1),
		blockHash: new Uint8Array(32).fill(2),
		txIndex: 0,
		index: 0,
		removed: false,
		...over,
	} as any
}

describe('onLatchCleared (reviewer override re-verifies immediately)', () => {
	test('a reviewer clear triggers a fresh check and a new report', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)
		const summary = onLatchCleared(runtime as any, clearLog())
		expect(seen.urls).toHaveLength(2)
		expect(seen.writes).toHaveLength(1)
		const [chainId, asOf, statuses] = decode(seen.writes[0].payload)
		expect(chainId).toBe(BigInt(network.chainId))
		expect(asOf).toBe(BigInt(NOW))
		expect([...statuses]).toEqual([Status.OK, Status.REVIEW, Status.REVIEW, Status.OK])
		expect(summary).toContain('STABLECOINS=OK')
	})

	test('a log from any other contract is refused before fetching or writing', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)
		const spoof = clearLog({ address: hexToBytes('0x000000000000000000000000000000000000bEEF') })
		expect(() => onLatchCleared(runtime as any, spoof)).toThrow('unexpected contract')
		expect(seen.urls).toHaveLength(0)
		expect(seen.writes).toHaveLength(0)
	})

	test('a different event from our contract is refused', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)
		const other = clearLog()
		other.topics[0] = hexToBytes(pad('0x1234', { size: 32 }))
		expect(() => onLatchCleared(runtime as any, other)).toThrow('unexpected event')
		expect(() => onLatchCleared(runtime as any, clearLog({ topics: [] }))).toThrow('unexpected event')
		expect(seen.writes).toHaveLength(0)
	})

	test('a log removed by a reorg is refused', () => {
		const seen = wire({ status: 200, body: JSON.stringify(LIVE_RESULTS) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onLatchCleared(runtime as any, clearLog({ removed: true }))).toThrow('reorg')
		expect(seen.writes).toHaveLength(0)
	})

	test('the re-check still fails closed: API error after a clear writes nothing', () => {
		const seen = wire({ status: 503, body: JSON.stringify({ count: 0 }) })
		const runtime = newTestRuntime(null, donTime, config)
		expect(() => onLatchCleared(runtime as any, clearLog())).toThrow('status 503')
		expect(seen.writes).toHaveLength(0)
	})
})
