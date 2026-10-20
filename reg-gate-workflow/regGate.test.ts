import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, hexToString, type Hex } from 'viem'
import {
	buildEffectiveQueryUrl,
	buildQueryUrl,
	CATEGORIES,
	categoriesFor,
	classify,
	computeWindow,
	deserializeResult,
	docToBytes32,
	encodeReport,
	type FrDocument,
	informationalReason,
	isOutOfScope,
	parseFederalRegisterResponse,
	serializeResult,
	severityFor,
	severityForType,
	Status,
	summarize,
	writeDecision,
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
	test('effective_on: a date is kept, null or absent becomes empty, anything else throws', () => {
		expect(parseFederalRegisterResponse(body([raw({ effective_on: '2026-11-17' })])).documents[0].effectiveOn).toBe(
			'2026-11-17',
		)
		expect(parseFederalRegisterResponse(body([raw({ effective_on: null })])).documents[0].effectiveOn).toBe('')
		expect(parseFederalRegisterResponse(body([raw()])).documents[0].effectiveOn).toBe('')
		expect(() => parseFederalRegisterResponse(body([raw({ effective_on: '11/17/2026' })]))).toThrow('effective_on')
		expect(() => parseFederalRegisterResponse(body([raw({ effective_on: 20261117 })]))).toThrow('effective_on')
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
		effectiveOn: '',
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

describe('effective dates: a final rule blocks when it takes effect, not when it is published', () => {
	const asDoc = (o: Record<string, unknown>) => parseFederalRegisterResponse(body([raw(o)])).documents[0]
	const FINAL = { ...GENIUS, document_number: '2026-19000', type: 'Rule', publication_date: '2026-09-15' }

	test('severityFor: pending rule is REVIEW; in effect, or effective that day, is BLOCK', () => {
		expect(severityFor(asDoc({ ...FINAL, effective_on: '2026-11-14' }), W.end)).toBe(Status.REVIEW)
		expect(severityFor(asDoc({ ...FINAL, effective_on: '2026-09-30' }), W.end)).toBe(Status.BLOCK)
		expect(severityFor(asDoc({ ...FINAL, effective_on: '2026-09-15' }), W.end)).toBe(Status.BLOCK)
	})
	test('severityFor: a final rule with no effective date fails closed to BLOCK', () => {
		expect(severityFor(asDoc({ ...FINAL, effective_on: null }), W.end)).toBe(Status.BLOCK)
	})
	test('severityFor: only a final rule earns the grace period', () => {
		// The API fills effective_on on some proposals; it changes nothing there.
		expect(severityFor(asDoc({ ...GENIUS, effective_on: '2026-08-18' }), W.end)).toBe(Status.REVIEW)
		// A future date never softens a presidential document or an unknown type.
		expect(severityFor(asDoc({ ...FINAL, type: 'Presidential Document', effective_on: '2026-12-01' }), W.end)).toBe(
			Status.BLOCK,
		)
		expect(severityFor(asDoc({ ...FINAL, type: 'Interim Final Rule', effective_on: '2026-12-01' }), W.end)).toBe(
			Status.BLOCK,
		)
	})
	test('classify: rule published in the window but effective later is REVIEW', () => {
		const r = run([raw({ ...FINAL, effective_on: '2026-11-14' })])
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.REVIEW)
		expect(r.triggerDocs[idx('STABLECOINS')]).toBe('2026-19000')
	})
	test('classify: rule published months earlier that takes effect in the window is BLOCK', () => {
		const old = raw({ ...FINAL, publication_date: '2026-05-01', effective_on: '2026-09-02' })
		const r = classify(parseFederalRegisterResponse(body([])), W.start, W.end, parseFederalRegisterResponse(body([old])))
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
		expect(r.triggerDocs[idx('STABLECOINS')]).toBe('2026-19000')
		expect(r.matched).toBe(1)
	})
	test('classify: a rule returned by both queries is counted once', () => {
		const both = raw({ ...FINAL, effective_on: '2026-09-20' })
		const p = parseFederalRegisterResponse(body([both]))
		const r = classify(p, W.start, W.end, p)
		expect(r.matched).toBe(1)
		expect(r.statuses[idx('STABLECOINS')]).toBe(Status.BLOCK)
	})
	test('classify: the effective-date query is not trusted either', () => {
		const empty = parseFederalRegisterResponse(body([]))
		const late = parseFederalRegisterResponse(body([raw({ ...FINAL, effective_on: '2026-10-05' })]))
		const undated = parseFederalRegisterResponse(body([raw({ ...FINAL, effective_on: null })]))
		const proposal = parseFederalRegisterResponse(body([raw({ ...GENIUS, effective_on: '2026-09-02' })]))
		expect(() => classify(empty, W.start, W.end, late)).toThrow('does not take effect in the requested window')
		expect(() => classify(empty, W.start, W.end, undated)).toThrow('does not take effect in the requested window')
		expect(() => classify(empty, W.start, W.end, proposal)).toThrow('not a final rule')
	})
	test('classify: a truncated effective-date query floors every category at REVIEW', () => {
		const empty = parseFederalRegisterResponse(body([]))
		const truncated = parseFederalRegisterResponse(body([], 120))
		const r = classify(empty, W.start, W.end, truncated)
		expect(r.truncated).toBe(true)
		expect(r.statuses).toEqual([Status.REVIEW, Status.REVIEW, Status.REVIEW, Status.REVIEW])
	})
})

describe('informational: seen and counted, never escalated', () => {
	const SEC_AGENCY = [{ name: 'Securities and Exchange Commission', slug: 'securities-and-exchange-commission' }]
	// Live shapes: 2026-21128 (Cboe filing) and 2026-20429 (FinCEN withdrawal), 2026-10.
	const SRO = raw({
		document_number: '2026-21128',
		title:
			'Self-Regulatory Organizations; Cboe BZX Exchange, Inc.; Notice of Filing of a Proposed Rule Change To List and Trade Options on Commodity-Based Trusts Holding Multiple Crypto Assets',
		type: 'Notice',
		publication_date: '2026-09-16',
		agencies: SEC_AGENCY,
	})
	const WITHDRAWAL = raw({
		document_number: '2026-20429',
		title:
			'Proposal of Special Measure Regarding Convertible Virtual Currency Mixing, as a Class of Transactions of Primary Money Laundering Concern; Withdrawal',
		type: 'Proposed Rule',
		publication_date: '2026-09-06',
		agencies: [
			{ name: 'Treasury Department', slug: 'treasury-department' },
			{ name: 'Financial Crimes Enforcement Network', slug: 'financial-crimes-enforcement-network' },
		],
	})
	const doc = (o: Record<string, unknown>) => parseFederalRegisterResponse(body([raw(o)])).documents[0]

	test('an exchange rule filing published by the SEC is informational', () => {
		expect(informationalReason(doc(SRO))).toBe('sro-filing')
		const r = run([SRO])
		expect(r.statuses).toEqual([Status.OK, Status.OK, Status.OK, Status.OK])
		expect(r.informational).toBe(1)
		expect(r.matched).toBe(0)
	})
	test('an agency withdrawing its own proposal is informational', () => {
		expect(informationalReason(doc(WITHDRAWAL))).toBe('withdrawn-proposal')
		const r = run([WITHDRAWAL])
		expect(r.statuses[idx('AML_SANCTIONS')]).toBe(Status.OK)
		expect(r.informational).toBe(1)
	})
	test('near misses take the normal path', () => {
		// SRO title, but another agency is on it.
		expect(informationalReason(doc({ ...SRO, agencies: [...SEC_AGENCY, { name: 'CFTC', slug: 'commodity-futures-trading-commission' }] }))).toBeNull()
		// SRO title, but a missing slug or no agency at all: unknown, so not excluded.
		expect(informationalReason(doc({ ...SRO, agencies: [{ raw_name: 'SEC' }] }))).toBeNull()
		expect(informationalReason(doc({ ...SRO, agencies: [] }))).toBeNull()
		// SRO title on a proposed or final rule: the SEC itself acting.
		expect(informationalReason(doc({ ...SRO, type: 'Proposed Rule' }))).toBeNull()
		expect(informationalReason(doc({ ...SRO, type: 'Rule' }))).toBeNull()
		// "Withdrawal" as a subject, not the action.
		expect(informationalReason(doc({ ...WITHDRAWAL, title: 'Withdrawal Limits for Digital Asset Custody Accounts' }))).toBeNull()
		// Withdrawing a final rule, or anything not a proposal, is a change in force: normal path.
		expect(informationalReason(doc({ ...WITHDRAWAL, type: 'Rule' }))).toBeNull()
		expect(informationalReason(doc({ ...WITHDRAWAL, type: 'Notice' }))).toBeNull()
	})
	test('informational documents never lower a real signal in the same category', () => {
		const r = run([SRO, REG_CRYPTO])
		expect(r.statuses[idx('DIGITAL_ASSET_MARKETS')]).toBe(Status.REVIEW)
		expect(r.triggerDocs[idx('DIGITAL_ASSET_MARKETS')]).toBe('2026-17183')
	})
	test('the summary reports the informational count', () => {
		expect(summarize(run([SRO, WITHDRAWAL, GENIUS]))).toContain('matched=1 ignored=0 informational=2')
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
	test('asks for effective dates', () => {
		expect(buildQueryUrl('https://www.federalregister.gov/api/v1/documents.json', W, 50)).toContain(
			'fields%5B%5D=effective_on',
		)
	})
	test('effective-date query: final rules only, bounded by effective date, not publication date', () => {
		const url = buildEffectiveQueryUrl('https://www.federalregister.gov/api/v1/documents.json', W, 50)
		expect(url).toContain('conditions%5Btype%5D%5B%5D=RULE')
		expect(url).toContain('conditions%5Beffective_date%5D%5Bgte%5D=2026-08-01')
		expect(url).toContain('conditions%5Beffective_date%5D%5Blte%5D=2026-09-30')
		expect(url).not.toContain('publication_date%5D')
		expect(url).not.toContain(' ')
	})
	test('refuses non-https', () => {
		expect(() => buildQueryUrl('http://www.federalregister.gov/api', W, 50)).toThrow('https')
		expect(() => buildEffectiveQueryUrl('http://www.federalregister.gov/api', W, 50)).toThrow('https')
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

describe('writeDecision (heartbeat: skip only when sure nothing changes)', () => {
	const r = run([REG_CRYPTO, GENIUS]) // STABLECOINS and TOKENIZED REVIEW, MARKETS REVIEW, AML OK
	const NOW = 1_800_000_000n
	const H = 3600n
	const held = (over: Record<string, unknown> = {}) => ({
		lastAsOf: NOW - 2n * H,
		maxAge: 7n * 24n * H,
		statuses: [...r.statuses],
		triggerDocs: r.triggerDocs.map(docToBytes32),
		...over,
	})
	test('identical status, fresh report: skip', () => {
		expect(writeDecision(held(), r, NOW, 24n * H)).toEqual({
			write: false,
			reason: 'unchanged, last report 7200s old (heartbeat at 86400s)',
		})
	})
	test('document hex compares case-insensitively', () => {
		const upper = held({ triggerDocs: r.triggerDocs.map((d) => docToBytes32(d).toUpperCase().replace('0X', '0x')) })
		expect(writeDecision(upper as any, r, NOW, 24n * H).write).toBe(false)
	})
	test('unreadable chain, bad shape, or no report yet: write', () => {
		expect(writeDecision(null, r, NOW, 24n * H)).toEqual({ write: true, reason: 'on-chain read failed' })
		expect(writeDecision(held({ statuses: [0, 1, 1] }) as any, r, NOW, 24n * H).write).toBe(true)
		expect(writeDecision(held({ triggerDocs: [] }) as any, r, NOW, 24n * H).write).toBe(true)
		expect(writeDecision(held({ lastAsOf: 0n }) as any, r, NOW, 24n * H).reason).toBe('no report on-chain yet')
	})
	test('any status or document change: write', () => {
		const st = held()
		st.statuses[idx('AML_SANCTIONS')] = Status.REVIEW
		expect(writeDecision(st as any, r, NOW, 24n * H).reason).toBe('AML_SANCTIONS changed')
		const dc = held()
		dc.triggerDocs[idx('STABLECOINS')] = docToBytes32('2026-99999')
		expect(writeDecision(dc as any, r, NOW, 24n * H).reason).toBe('STABLECOINS changed')
	})
	test('heartbeat boundary: one second short skips, exactly due writes', () => {
		expect(writeDecision(held({ lastAsOf: NOW - 24n * H + 1n }) as any, r, NOW, 24n * H).write).toBe(false)
		expect(writeDecision(held({ lastAsOf: NOW - 24n * H }) as any, r, NOW, 24n * H).write).toBe(true)
	})
	test('a heartbeat longer than half of maxAge is capped, so skips can never run a chain stale', () => {
		const twoDays = held({ maxAge: 48n * H, lastAsOf: NOW - 24n * H })
		expect(writeDecision(twoDays as any, r, NOW, 168n * H).write).toBe(true)
		expect(writeDecision(held({ maxAge: 0n }) as any, r, NOW, 24n * H).write).toBe(true)
	})
})
