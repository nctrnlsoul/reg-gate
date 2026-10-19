import { describe, expect } from 'bun:test'
import { newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { configSchema, initWorkflow, onCronTrigger } from './workflow'

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
	test('registers exactly one cron handler on the configured schedule', () => {
		const handlers = initWorkflow(base)
		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		const trigger = handlers[0].trigger as { config?: { schedule?: string } }
		expect(trigger.config?.schedule).toBe(base.schedule)
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
