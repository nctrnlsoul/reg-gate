import { test as bunTest, describe, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, encodeEventTopics, toFunctionSelector, type Abi, type AbiFunction } from 'viem'
import {
	configSchema,
	initWorkflow,
	LATCH_CLEARED_TOPIC,
	onCronTrigger,
	onLatchCleared,
	STATUS_READ_ABI,
} from './workflow'

const base = {
	schedule: '0 0 */6 * * *',
	frBaseUrl: 'https://www.federalregister.gov/api/v1/documents.json',
	lookbackDays: 14,
	perPage: 50,
	chainSelectorName: 'ethereum-testnet-sepolia',
	isTestnet: true,
	receiverAddress: '0x000000000000000000000000000000000000dEaD',
	gasLimit: '500000',
}

describe('configSchema (reject bad config before anything runs)', () => {
	test('accepts the staging config shape', () => {
		expect(configSchema.safeParse(base).success).toBe(true)
	})
	test('rejects a non-Federal-Register URL', () => {
		expect(configSchema.safeParse({ ...base, frBaseUrl: 'https://evil.example/api' }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, frBaseUrl: 'http://www.federalregister.gov/api/v1/x' }).success).toBe(false)
		// Exact endpoint only: no extra query string, no other endpoint (audit 2026-10-20).
		expect(configSchema.safeParse({ ...base, frBaseUrl: `${base.frBaseUrl}?conditions[agencies][]=x` }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, frBaseUrl: 'https://www.federalregister.gov/api/v1/public-inspection-documents.json' }).success).toBe(false)
	})
	test('rejects the zero address and malformed addresses', () => {
		expect(configSchema.safeParse({ ...base, receiverAddress: `0x${'0'.repeat(40)}` }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, receiverAddress: '0x1234' }).success).toBe(false)
	})
	test('rejects out-of-range numbers and unknown keys', () => {
		expect(configSchema.safeParse({ ...base, lookbackDays: 0 }).success).toBe(false)
		// Shorter than the contract's 14-day gap rule would leave a smaller gap unseen and unflagged.
		expect(configSchema.safeParse({ ...base, lookbackDays: 13 }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, lookbackDays: 14 }).success).toBe(true)
		expect(configSchema.safeParse({ ...base, perPage: 500 }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, gasLimit: '0' }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, extra: true }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, heartbeatHours: 0 }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, heartbeatHours: 169 }).success).toBe(false)
	})
	const mirror = {
		chainSelectorName: 'ethereum-testnet-sepolia-base-1',
		isTestnet: true,
		receiverAddress: '0x000000000000000000000000000000000000bA5E',
		gasLimit: '1000000',
	}
	test('accepts a heartbeat and a mirror chain', () => {
		expect(configSchema.safeParse({ ...base, heartbeatHours: 24, mirrors: [mirror] }).success).toBe(true)
	})
	test('rejects a mirror that repeats a chain, or a bad mirror', () => {
		expect(configSchema.safeParse({ ...base, mirrors: [{ ...mirror, chainSelectorName: base.chainSelectorName }] }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, mirrors: [mirror, mirror] }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, mirrors: [{ ...mirror, receiverAddress: `0x${'0'.repeat(40)}` }] }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, mirrors: [{ ...mirror, extra: 1 }] }).success).toBe(false)
	})
	test('the committed configs parse', () => {
		for (const f of ['config.staging.json', 'config.production.json']) {
			const cfg = JSON.parse(readFileSync(join(import.meta.dir, f), 'utf-8'))
			expect(configSchema.safeParse(cfg).success).toBe(true)
		}
	})
})

describe('initWorkflow', () => {
	test('handler 0 is the cron heartbeat on the configured schedule', () => {
		const handlers = initWorkflow(base)
		expect(handlers).toHaveLength(2)
		expect(handlers[0].fn).toBe(onCronTrigger)
		const trigger = handlers[0].trigger as { config?: { schedule?: string } }
		expect(trigger.config?.schedule).toBe(base.schedule)
	})
	test('handler 1 listens for LatchCleared on the receiver contract only', () => {
		const handlers = initWorkflow(base)
		expect(handlers[1].fn).toBe(onLatchCleared)
		const trigger = handlers[1].trigger as any
		expect(trigger.method()).toBe('LogTrigger')
		const addresses = trigger.config.addresses.map((a: Uint8Array) => bytesToHex(a).toLowerCase())
		expect(addresses).toEqual([base.receiverAddress.toLowerCase()])
		expect(trigger.config.topics).toHaveLength(1)
		expect(trigger.config.confidence).toBe(0) // ConfidenceLevel.SAFE: not the newest unconfirmed block
		const topic0 = trigger.config.topics[0].values.map((v: Uint8Array) => bytesToHex(Uint8Array.from(Object.values(v))))
		expect(topic0).toEqual([LATCH_CLEARED_TOPIC])
	})
	test('the topic matches the event the deployed contract actually emits', () => {
		// Cross-check against the compiled contract ABI, so a renamed or re-typed event
		// in RegGateStatus.sol cannot silently leave the trigger listening for nothing.
		const artifact = JSON.parse(readFileSync(join(import.meta.dir, '../deploy/artifacts/RegGateStatus.json'), 'utf-8'))
		const [topic] = encodeEventTopics({ abi: artifact.abi as Abi, eventName: 'LatchCleared' })
		expect(topic).toBe(LATCH_CLEARED_TOPIC)
	})
	test('the heartbeat reads functions the deployed contract actually has', () => {
		const artifact = JSON.parse(readFileSync(join(import.meta.dir, '../deploy/artifacts/RegGateStatus.json'), 'utf-8'))
		const compiled = new Set(
			(artifact.abi as Abi).filter((x): x is AbiFunction => x.type === 'function').map((f) => toFunctionSelector(f)),
		)
		for (const f of STATUS_READ_ABI) expect(compiled.has(toFunctionSelector(f))).toBe(true)
	})
	test('a reviewer clear on the mirror chain also triggers a re-check (handler 2)', () => {
		const mirror = { chainSelectorName: 'ethereum-testnet-sepolia-base-1', isTestnet: true, receiverAddress: '0x000000000000000000000000000000000000bA5E', gasLimit: '1' }
		const handlers = initWorkflow({ ...base, mirrors: [mirror] })
		expect(handlers).toHaveLength(3)
		expect(handlers[2].fn).toBe(onLatchCleared)
		const trigger = handlers[2].trigger as any
		expect(trigger.config.addresses.map((a: Uint8Array) => bytesToHex(a).toLowerCase())).toEqual([mirror.receiverAddress.toLowerCase()])
	})
	test('fails fast on an unknown chain name, primary or mirror', () => {
		expect(() => initWorkflow({ ...base, chainSelectorName: 'not-a-chain' })).toThrow('Network not found')
		const badMirror = { chainSelectorName: 'not-a-chain', isTestnet: true, receiverAddress: base.receiverAddress, gasLimit: '1' }
		expect(() => initWorkflow({ ...base, mirrors: [badMirror] })).toThrow('Network not found')
	})
})

describe('onCronTrigger', () => {
	test('throws when scheduledExecutionTime is missing', () => {
		const runtime = newTestRuntime()
		expect(() => onCronTrigger(runtime as any, {} as any)).toThrow('Scheduled execution time is required')
	})
})

describe('status page rules (docs/rules.js)', () => {
	// Skipped only inside planted-bugs.ts, where every rules.ts edit would trip this byte check.
	bunTest.skipIf(process.env.PLANTED_BUGS === '1')('the committed docs/rules.js is exactly a fresh build of rules.ts', async () => {
		const { buildRulesJs, RULES_JS } = await import('./build-page')
		const norm = (s: string) => s.replace(/\r\n/g, '\n')
		expect(norm(readFileSync(RULES_JS, 'utf-8'))).toBe(norm(await buildRulesJs()))
	})
})
