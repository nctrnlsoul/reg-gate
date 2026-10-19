import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, hexToString, type Hex } from 'viem'
import {
	buildQueryUrl,
	CATEGORIES,
	categoriesFor,
	classify,
	computeWindow,
	deserializeResult,
	encodeReport,
	type FrDocument,
	isOutOfScope,
	parseFederalRegisterResponse,
	serializeResult,
	severityForType,
	Status,
} from './regGate'

const W = { start: '2026-08-01', end: '2026-09-30' }
const idx = (c: (typeof CATEGORIES)[number]) => CATEGORIES.indexOf(c)

// Shapes mirror live results from the Federal Register API (pulled 2026-10-18).
const raw = (overrides: Record<string, unknown> = {}) => ({
	document_number: '2026-00001',
	title: 'Some Title',
	type: 'Notice',
	publication_date: '2026-09-01',
	abstract: '',
	agencies: [{ raw_name: 'TREASURY', name: 'Treasury Department', id: 497, slug: 'treasury-department' }],
	...overrides,
})
const body = (results: unknown[], count = results.length) => JSON.stringify({ description: 'x', count, results })
const run = (results: unknown[], count?: number) =>
	classify(parseFederalRegisterResponse(body(results, count)), W.start, W.end)

const GENIUS = raw({
	document_number: '2026-16796',
	title: 'GENIUS Act Regulations on Payment Stablecoin Issuance, Offer, and Sale',
	type: 'Proposed Rule',
	publication_date: '2026-08-18',
	abstract: 'Treasury proposes rules implementing section 3 of the GENIUS Act.',
})
const REG_CRYPTO = raw({
	document_number: '2026-17183',
	title: 'Regulation Crypto Assets',
	type: 'Proposed Rule',
	publication_date: '2026-08-21',
	abstract: 'A tailored offering regime for certain crypto asset investment contracts.',
	agencies: [{ name: 'Securities and Exchange Commission', slug: 'securities-and-exchange-commission' }],
})
const UNSAFE_PRACTICES = raw({
	document_number: '2026-17823',
	title: 'Unsafe or Unsound Practices, Matters Requiring Attention',
	type: 'Rule',
	abstract: 'The OCC and the FDIC are adopting a rule defining unsafe or unsound practices.',
	agencies: [
		{ name: 'Comptroller of the Currency', slug: 'comptroller-of-the-currency' },
		{ name: 'Federal Deposit Insurance Corporation', slug: 'federal-deposit-insurance-corporation' },
	],
})
const UNIFIED_AGENDA = raw({
	document_number: '2026-16603',
	title: 'Introduction to the Unified Agenda of Federal Regulatory and Deregulatory Actions-2026',
	type: 'Notice',
	abstract: 'Includes digital asset items.',
	agencies: [{ name: 'Regulatory Information Service Center', slug: 'regulatory-information-service-center' }],
})

describe('parseFederalRegisterResponse (fail closed on surprises)', () => {
	test('parses a well-formed response', () => {
		const p = parseFederalRegisterResponse(body([GENIUS]))
		expect(p.count).toBe(1)
		expect(p.documents[0].documentNumber).toBe('2026-16796')
		expect(p.documents[0].agencySlugs).toEqual(['treasury-department'])
	})
	test('zero results with no results key is valid and empty', () => {
		expect(parseFederalRegisterResponse(JSON.stringify({ count: 0, description: 'x' })).documents).toEqual([])
	})
	test('throws on missing results when count is nonzero', () => {
		expect(() => parseFederalRegisterResponse(JSON.stringify({ count: 3 }))).toThrow()
	})
	test('throws on non-JSON', () => {
		expect(() => parseFederalRegisterResponse('<html>rate limited</html>')).toThrow('not valid JSON')
	})
	test('throws on a JSON array or missing count', () => {
		expect(() => parseFederalRegisterResponse('[]')).toThrow()
		expect(() => parseFederalRegisterResponse(JSON.stringify({ results: [] }))).toThrow('count')
	})
	test('throws when a required field is missing or malformed', () => {
		expect(() => parseFederalRegisterResponse(body([raw({ type: undefined })]))).toThrow('type')
		expect(() => parseFederalRegisterResponse(body([raw({ title: '' })]))).toThrow('title')
		expect(() => parseFederalRegisterResponse(body([raw({ publication_date: '9/1/2026' })]))).toThrow('publication_date')
		expect(() => parseFederalRegisterResponse(body([raw({ agencies: null })]))).toThrow('agencies')
		expect(() => parseFederalRegisterResponse(body([raw({ abstract: 42 })]))).toThrow('abstract')
	})
	test('null abstract becomes empty string, missing slug becomes empty string', () => {
		const p = parseFederalRegisterResponse(body([raw({ abstract: null, agencies: [{ raw_name: 'X' }] })]))
		expect(p.documents[0].abstract).toBe('')
		expect(p.documents[0].agencySlugs).toEqual([''])
	})
})

describe('severityForType', () => {
	test('final rules and presidential documents block', () => {
		expect(severityForType('Rule')).toBe(Status.BLOCK)
		expect(severityForType('Presidential Document')).toBe(Status.BLOCK)
	})
	test('proposals and notices go to review', () => {
		expect(severityForType('Proposed Rule')).toBe(Status.REVIEW)
		expect(severityForType('Notice')).toBe(Status.REVIEW)
	})
	test('unknown type fails closed to BLOCK', () => {
		expect(severityForType('Correction')).toBe(Status.BLOCK)
		expect(severityForType('')).toBe(Status.BLOCK)
	})
})

describe('categoriesFor', () => {
	const doc = (title: string, abstract = '', agencySlugs = ['treasury-department']): FrDocument => ({
		documentNumber: 'x',
		title,
		type: 'Notice',
		publicationDate: '2026-09-01',
		abstract,
		agencySlugs,
	})
	test('stablecoin rule hits STABLECOINS', () => {
		expect(categoriesFor(doc('GENIUS Act Regulations on Payment Stablecoin Issuance'))).toEqual(['STABLECOINS'])
	})
	test('Regulation Crypto hits tokenized securities and digital asset markets', () => {
		expect(categoriesFor(doc('Regulation Crypto Assets', 'crypto asset investment contracts', ['securities-and-exchange-commission']))).toEqual([
			'TOKENIZED_SECURITIES',
			'DIGITAL_ASSET_MARKETS',
		])
	})
	test('"Regulation Crypto" means tokenized securities only from the SEC (live false positive 2026-20888)', () => {
		const cftc = doc(
			'Regulation Crypto Asset Transactions and Regulation Crypto Asset Markets',
			'',
			['commodity-futures-trading-commission'],
		)
		expect(categoriesFor(cftc)).toEqual(['DIGITAL_ASSET_MARKETS'])
		const sec = doc('Regulation Crypto Assets', '', ['securities-and-exchange-commission'])
		expect(categoriesFor(sec)).toContain('TOKENIZED_SECURITIES')
	})
	test('AML needs a digital asset context, not just sanctions', () => {
		expect(categoriesFor(doc('Sanctions on Shipping Entities', '', ['foreign-assets-control-office']))).toEqual([])
		expect(categoriesFor(doc('Sanctions on a Cryptocurrency Mixer', '', ['foreign-assets-control-office']))).toContain(
			'AML_SANCTIONS',
		)
	})
	test('FinCEN plus digital asset hits AML even without an AML keyword', () => {
		expect(
			categoriesFor(doc('Reporting for Virtual Currency Transactions', '', ['financial-crimes-enforcement-network'])),
		).toContain('AML_SANCTIONS')
	})
	test('word boundaries: "cryptographic" and "cryptography" are not crypto', () => {
		expect(categoriesFor(doc('Cryptographic Module Validation Program', 'post-quantum cryptography'))).toEqual([])
	})
	test('matches in the abstract count, case-insensitive', () => {
		expect(categoriesFor(doc('Capital Requirements', 'Applies to BITCOIN custody.'))).toContain('DIGITAL_ASSET_MARKETS')
	})
})

describe('isOutOfScope', () => {
	const d = (agencySlugs: string[]) => ({ agencySlugs }) as FrDocument
	test('unwatched agency is out of scope', () => {
		expect(isOutOfScope(d(['national-institute-of-standards-and-technology']))).toBe(true)
	})
	test('one watched agency among several keeps it in scope', () => {
		expect(isOutOfScope(d(['some-agency', 'treasury-department']))).toBe(false)
	})
	test('missing slug or no agencies stays in scope (caution over silence)', () => {
		expect(isOutOfScope(d(['']))).toBe(false)
		expect(isOutOfScope(d([]))).toBe(false)
	})
})

describe('classify', () => {
	test('quiet window is all OK', () => {
		const r = run([UNSAFE_PRACTICES])
		expect(r.statuses).toEqual([Status.OK, Status.OK, Status.OK, Status.OK])
		expect(r.triggerDocs).toEqual(['', '', '', ''])
		expect(r.ignored).toBe(1)
		expect(r.matched).toBe(0)
	})
	test('real-shaped mix: proposals flag REVIEW, noise ignored', () => {
		const r = run([UNSAFE_PRACTICES, REG_CRYPTO, GENIUS, UNIFIED_AGENDA])
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.REVIEW)
		expect(r.triggerDocs[idx('STABLECOINS')]).toBe('2026-16796')
		expect(r.statuses[idx('TOKENIZED_SECURITIES')]).toBe(Status.REVIEW)
		expect(r.triggerDocs[idx('TOKENIZED_SECURITIES')]).toBe('2026-17183')
		expect(r.statuses[idx('DIGITAL_ASSET_MARKETS')]).toBe(Status.REVIEW)
		expect(r.statuses[idx('AML_SANCTIONS')]).toBe(Status.OK)
		expect(r.matched).toBe(2)
		expect(r.ignored).toBe(2)
	})
	test('final rule escalates to BLOCK and wins over a newer proposal', () => {
		const finalRule = raw({ ...GENIUS, document_number: '2026-20000', type: 'Rule', publication_date: '2026-09-10' })
		const newerProposal = raw({ ...GENIUS, document_number: '2026-21000', publication_date: '2026-09-20' })
		const r = run([newerProposal, finalRule])
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
		expect(r.triggerDocs[idx('STABLECOINS')]).toBe('2026-20000')
	})
	test('same severity: newest document is the trigger, regardless of input order', () => {
		const a = raw({ ...GENIUS, document_number: '2026-10000', publication_date: '2026-08-05' })
		const b = raw({ ...GENIUS, document_number: '2026-11000', publication_date: '2026-09-05' })
		expect(run([a, b]).triggerDocs[idx('STABLECOINS')]).toBe('2026-11000')
		expect(run([b, a]).triggerDocs[idx('STABLECOINS')]).toBe('2026-11000')
	})
	test('unknown document type on a match fails closed to BLOCK', () => {
		const r = run([raw({ ...GENIUS, type: 'Sunshine Correction' })])
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
	})
	test('truncated results floor every category at REVIEW', () => {
		const r = run([UNSAFE_PRACTICES], 75)
		expect(r.truncated).toBe(true)
		expect(r.statuses).toEqual([Status.REVIEW, Status.REVIEW, Status.REVIEW, Status.REVIEW])
	})
	test('truncation never lowers an existing BLOCK', () => {
		const r = run([raw({ ...GENIUS, type: 'Rule' })], 99)
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
	})
	test('document outside the requested window throws (do not trust the query)', () => {
		expect(() => run([raw({ ...GENIUS, publication_date: '2026-10-15' })])).toThrow('outside requested window')
	})
	test('presidential document on digital assets blocks', () => {
		const eo = raw({
			document_number: '2026-30000',
			title: 'Establishment of the Strategic Bitcoin Reserve and United States Digital Asset Stockpile',
			type: 'Presidential Document',
			agencies: [{ name: 'Executive Office of the President', slug: 'executive-office-of-the-president' }],
		})
		expect(run([eo]).statuses[idx('DIGITAL_ASSET_MARKETS')]).toBe(Status.BLOCK)
	})
})

describe('computeWindow', () => {
	test('ends the day before the scheduled run (UTC)', () => {
		// 2026-10-19T01:59:23Z
		expect(computeWindow(Date.UTC(2026, 9, 19, 1, 59, 23) / 1000, 14)).toEqual({ start: '2026-10-05', end: '2026-10-18' })
	})
	test('every moment of the same UTC day gives the same window (node agreement)', () => {
		const a = computeWindow(Date.UTC(2026, 9, 19, 0, 0, 0) / 1000, 7)
		const b = computeWindow(Date.UTC(2026, 9, 19, 23, 59, 59) / 1000, 7)
		expect(a).toEqual(b)
	})
	test('rejects bad inputs', () => {
		expect(() => computeWindow(0, 7)).toThrow()
		expect(() => computeWindow(1.5, 7)).toThrow()
		expect(() => computeWindow(1_800_000_000, 0)).toThrow()
		expect(() => computeWindow(1_800_000_000, 91)).toThrow()
	})
})

describe('buildQueryUrl', () => {
	test('encodes brackets and terms, bounds the window', () => {
		const url = buildQueryUrl('https://www.federalregister.gov/api/v1/documents.json', W, 50)
		expect(url).toContain('per_page=50')
		expect(url).toContain('fields%5B%5D=abstract')
		expect(url).toContain('conditions%5Bpublication_date%5D%5Bgte%5D=2026-08-01')
		expect(url).toContain('conditions%5Bpublication_date%5D%5Blte%5D=2026-09-30')
		expect(url).not.toContain(' ')
		expect(url).not.toContain('"')
	})
	test('refuses non-https', () => {
		expect(() => buildQueryUrl('http://www.federalregister.gov/api', W, 50)).toThrow('https')
	})
})

describe('serialize and report encoding', () => {
	const r = run([REG_CRYPTO, GENIUS])
	test('serialization round-trips and is stable', () => {
		const s = serializeResult(r)
		expect(serializeResult(deserializeResult(s))).toBe(s)
		expect(serializeResult(run([GENIUS, REG_CRYPTO]))).toBe(s) // input order does not matter
	})
	test('deserialize rejects tampered statuses', () => {
		const bad = JSON.parse(serializeResult(r))
		bad.statuses[0] = 7
		expect(() => deserializeResult(JSON.stringify(bad))).toThrow()
	})
	test('report decodes to the expected tuple', () => {
		const hex = encodeReport(11155111n, 1_792_375_163n, r)
		const [chainId, asOf, statuses, docs] = decodeAbiParameters(
			[{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint8[4]' }, { type: 'bytes32[4]' }],
			hex,
		)
		expect(chainId).toBe(11155111n)
		expect(asOf).toBe(1_792_375_163n)
		expect([...statuses]).toEqual(r.statuses)
		expect(hexToString(docs[idx('STABLECOINS')] as Hex, { size: 32 })).toBe('2026-16796')
		expect(docs[idx('AML_SANCTIONS')]).toBe(`0x${'00'.repeat(32)}`)
	})
})
