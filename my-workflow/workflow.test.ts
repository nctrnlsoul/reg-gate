import { describe, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, encodeEventTopics, type Abi } from 'viem'
import { configSchema, initWorkflow, LATCH_CLEARED_TOPIC, onCronTrigger, onLatchCleared } from './workflow'

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
	})
	test('rejects the zero address and malformed addresses', () => {
		expect(configSchema.safeParse({ ...base, receiverAddress: `0x${'0'.repeat(40)}` }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, receiverAddress: '0x1234' }).success).toBe(false)
	})
	test('rejects out-of-range numbers and unknown keys', () => {
		expect(configSchema.safeParse({ ...base, lookbackDays: 0 }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, perPage: 500 }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, gasLimit: '0' }).success).toBe(false)
		expect(configSchema.safeParse({ ...base, extra: true }).success).toBe(false)
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
	test('fails fast on an unknown chain name', () => {
		expect(() => initWorkflow({ ...base, chainSelectorName: 'not-a-chain' })).toThrow('Network not found')
	})
})

describe('onCronTrigger', () => {
	test('throws when scheduledExecutionTime is missing', () => {
		const runtime = newTestRuntime()
		expect(() => onCronTrigger(runtime as any, {} as any)).toThrow('Scheduled execution time is required')
	})
})
