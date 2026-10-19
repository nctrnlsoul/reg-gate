// Reg-Gate classifier.
//
// Pure, deterministic logic: no network, no clock, no randomness. Every node in a
// CRE DON runs this on the same input and must reach the same output, so it
// cannot use an LLM or anything time-dependent.
//
// Fail-closed rules:
//   - A response that does not match the expected shape throws. The workflow then
//     writes nothing, and the on-chain contract treats missing or stale data as BLOCK.
//   - A matched document of an unknown type is BLOCK, not OK.
//   - A truncated result set (more documents than we received) floors every
//     category at REVIEW, because we cannot vouch for what we did not see.
//
// Claim boundary: this flags regulatory publications for human review.
// It is not legal advice and does not interpret the law.

import { encodeAbiParameters, stringToHex, type Hex } from 'viem'

export const CATEGORIES = [
	'STABLECOINS',
	'TOKENIZED_SECURITIES',
	'DIGITAL_ASSET_MARKETS',
	'AML_SANCTIONS',
] as const
export type Category = (typeof CATEGORIES)[number]

export const Status = { OK: 0, REVIEW: 1, BLOCK: 2 } as const
export type StatusCode = (typeof Status)[keyof typeof Status]
export const STATUS_NAMES = ['OK', 'REVIEW', 'BLOCK'] as const

export interface FrDocument {
	documentNumber: string
	title: string
	type: string
	publicationDate: string // YYYY-MM-DD
	abstract: string
	agencySlugs: string[] // '' when the API gave no slug
}

export interface ParsedResponse {
	count: number
	documents: FrDocument[]
}

export interface GateResult {
	windowStart: string
	windowEnd: string
	statuses: StatusCode[] // index matches CATEGORIES
	triggerDocs: string[] // document number behind each status, '' when OK
	matched: number
	ignored: number
	truncated: boolean
}

// Agencies whose publications can move a category. Slugs verified against
// https://www.federalregister.gov/api/v1/agencies/<slug> on 2026-10-18.
export const WATCHED_AGENCIES = new Set<string>([
	'securities-and-exchange-commission',
	'commodity-futures-trading-commission',
	'treasury-department',
	'comptroller-of-the-currency',
	'federal-deposit-insurance-corporation',
	'federal-reserve-system',
	'financial-crimes-enforcement-network',
	'foreign-assets-control-office',
	'consumer-financial-protection-bureau',
	'internal-revenue-service',
	'executive-office-of-the-president',
])

const AML_AGENCIES = new Set<string>(['financial-crimes-enforcement-network', 'foreign-assets-control-office'])

const STABLECOIN_TERMS = [/\bstablecoins?\b/, /\bgenius act\b/]
const TOKENIZED_TERMS = [
	/\btokeni[sz](ed|ation)\b/,
	/\bcrypto asset investment contracts?\b/,
	/\bsecurity tokens?\b/,
	/\bdigital asset securit(y|ies)\b/,
]
// "Regulation Crypto" names both the SEC's securities proposal and the CFTC's
// commodity-market proposal. It means tokenized securities only from the SEC.
const SEC_ONLY_TOKENIZED_TERMS = [/\bregulation crypto\b/]
const SEC = 'securities-and-exchange-commission'
const DIGITAL_ASSET_TERMS = [
	/\bdigital assets?\b/,
	/\bcrypto\b/,
	/\bcrypto[- ]assets?\b/,
	/\bcryptocurrenc(y|ies)\b/,
	/\bvirtual currenc(y|ies)\b/,
	/\bbitcoin\b/,
	/\bblockchain\b/,
	/\bdistributed ledger\b/,
	/\bdecentralized finance\b/,
	/\bdefi\b/,
]
const AML_TERMS = [
	/\bmoney laundering\b/,
	/\banti-money laundering\b/,
	/\bbank secrecy act\b/,
	/\bsanction(s|ed)?\b/,
	/\bmixers?\b/,
	/\bmixing\b/,
	/\bterrorist financing\b/,
]
// Procedural notices that mention crypto but carry no rule change.
const PROCEDURAL_TITLES = [/^agenda$/, /\bunified agenda\b/, /\bregulatory agenda\b/, /^sunshine act meetings?\b/]

// Federal Register search terms used to pull candidates. Broad on purpose:
// the classifier above decides relevance, the query only narrows the payload.
export const SEARCH_TERM =
	'stablecoin | stablecoins | "digital asset" | "digital assets" | crypto | cryptocurrency | "virtual currency" | bitcoin | tokenized | tokenization | blockchain | "distributed ledger"'

export const FIELDS = ['document_number', 'title', 'type', 'publication_date', 'abstract', 'agencies'] as const

const anyMatch = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text))

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Strict parse of the Federal Register documents.json response. Throws on any surprise. */
export function parseFederalRegisterResponse(body: string): ParsedResponse {
	let raw: unknown
	try {
		raw = JSON.parse(body)
	} catch {
		throw new Error('FR response is not valid JSON')
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('FR response is not a JSON object')
	}
	const obj = raw as Record<string, unknown>
	if (typeof obj.count !== 'number' || !Number.isInteger(obj.count) || obj.count < 0) {
		throw new Error('FR response has no valid count')
	}
	// The API omits `results` entirely when nothing matched.
	if (obj.results === undefined) {
		if (obj.count !== 0) throw new Error('FR response missing results with nonzero count')
		return { count: 0, documents: [] }
	}
	if (!Array.isArray(obj.results)) throw new Error('FR results is not an array')

	const documents = obj.results.map((item, i): FrDocument => {
		if (typeof item !== 'object' || item === null) throw new Error(`FR result ${i} is not an object`)
		const r = item as Record<string, unknown>
		if (!isNonEmptyString(r.document_number)) throw new Error(`FR result ${i} missing document_number`)
		if (!isNonEmptyString(r.title)) throw new Error(`FR result ${i} missing title`)
		if (!isNonEmptyString(r.type)) throw new Error(`FR result ${i} missing type`)
		if (!isNonEmptyString(r.publication_date) || !DATE_RE.test(r.publication_date)) {
			throw new Error(`FR result ${i} has bad publication_date`)
		}
		if (r.abstract !== null && r.abstract !== undefined && typeof r.abstract !== 'string') {
			throw new Error(`FR result ${i} has bad abstract`)
		}
		if (!Array.isArray(r.agencies)) throw new Error(`FR result ${i} missing agencies`)
		const agencySlugs = r.agencies.map((a, j) => {
			if (typeof a !== 'object' || a === null) throw new Error(`FR result ${i} agency ${j} is not an object`)
			const slug = (a as Record<string, unknown>).slug
			return typeof slug === 'string' ? slug : ''
		})
		return {
			documentNumber: r.document_number,
			title: r.title,
			type: r.type,
			publicationDate: r.publication_date,
			abstract: typeof r.abstract === 'string' ? r.abstract : '',
			agencySlugs,
		}
	})
	return { count: obj.count, documents }
}

/** Severity a matched document carries. Unknown types fail closed to BLOCK. */
export function severityForType(type: string): StatusCode {
	switch (type.trim().toLowerCase()) {
		case 'rule':
		case 'presidential document':
			return Status.BLOCK
		case 'proposed rule':
		case 'notice':
			return Status.REVIEW
		default:
			return Status.BLOCK
	}
}

/** Which categories a document touches. Empty means not relevant. */
export function categoriesFor(doc: FrDocument): Category[] {
	const text = `${doc.title} ${doc.abstract}`.toLowerCase()
	const isStablecoin = anyMatch(STABLECOIN_TERMS, text)
	const isTokenized =
		anyMatch(TOKENIZED_TERMS, text) || (doc.agencySlugs.includes(SEC) && anyMatch(SEC_ONLY_TOKENIZED_TERMS, text))
	const isDigitalAsset = anyMatch(DIGITAL_ASSET_TERMS, text) || isStablecoin || isTokenized

	const out: Category[] = []
	if (isStablecoin) out.push('STABLECOINS')
	if (isTokenized) out.push('TOKENIZED_SECURITIES')
	if (anyMatch(DIGITAL_ASSET_TERMS, text)) out.push('DIGITAL_ASSET_MARKETS')
	const amlAgency = doc.agencySlugs.some((s) => AML_AGENCIES.has(s))
	if (isDigitalAsset && (amlAgency || anyMatch(AML_TERMS, text))) out.push('AML_SANCTIONS')
	return out
}

/**
 * Out of scope if every agency is known and none is watched. A missing slug
 * counts as unknown, so the document stays in scope (caution over silence).
 */
export function isOutOfScope(doc: FrDocument): boolean {
	if (doc.agencySlugs.length === 0) return false
	if (doc.agencySlugs.some((s) => s === '')) return false
	return !doc.agencySlugs.some((s) => WATCHED_AGENCIES.has(s))
}

export function isProcedural(doc: FrDocument): boolean {
	const title = doc.title.trim().toLowerCase()
	return PROCEDURAL_TITLES.some((p) => p.test(title))
}

// Deterministic tie-break: newest publication date first, then document number.
const moreRecent = (a: FrDocument, b: FrDocument) =>
	a.publicationDate !== b.publicationDate
		? a.publicationDate > b.publicationDate
		: a.documentNumber > b.documentNumber

export function classify(parsed: ParsedResponse, windowStart: string, windowEnd: string): GateResult {
	const statuses: StatusCode[] = CATEGORIES.map(() => Status.OK)
	const triggers: (FrDocument | null)[] = CATEGORIES.map(() => null)
	let matched = 0
	let ignored = 0

	for (const doc of parsed.documents) {
		// The query already bounds the window; enforce it again rather than trust it.
		if (doc.publicationDate < windowStart || doc.publicationDate > windowEnd) {
			throw new Error(`FR document ${doc.documentNumber} outside requested window`)
		}
		if (isOutOfScope(doc) || isProcedural(doc)) {
			ignored++
			continue
		}
		const cats = categoriesFor(doc)
		if (cats.length === 0) {
			ignored++
			continue
		}
		matched++
		const sev = severityForType(doc.type)
		for (const cat of cats) {
			const i = CATEGORIES.indexOf(cat)
			const current = triggers[i]
			if (sev > statuses[i] || (sev === statuses[i] && current !== null && moreRecent(doc, current))) {
				statuses[i] = sev
				triggers[i] = doc
			}
		}
	}

	const truncated = parsed.count > parsed.documents.length
	if (truncated) {
		for (let i = 0; i < statuses.length; i++) {
			if (statuses[i] < Status.REVIEW) statuses[i] = Status.REVIEW
		}
	}

	return {
		windowStart,
		windowEnd,
		statuses,
		triggerDocs: triggers.map((d) => (d ? d.documentNumber : '')),
		matched,
		ignored,
		truncated,
	}
}

const DAY_MS = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Lookback window ending the day before the scheduled run. Using yesterday, not
 * today, keeps every node on the same finished day of publications, so they agree.
 */
export function computeWindow(scheduledUnixSeconds: number, lookbackDays: number): { start: string; end: string } {
	if (!Number.isInteger(scheduledUnixSeconds) || scheduledUnixSeconds <= 0) {
		throw new Error('scheduled time must be a positive integer')
	}
	if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
		throw new Error('lookbackDays must be an integer from 1 to 90')
	}
	const dayStart = Math.floor((scheduledUnixSeconds * 1000) / DAY_MS) * DAY_MS
	const endMs = dayStart - DAY_MS
	return { start: isoDate(endMs - (lookbackDays - 1) * DAY_MS), end: isoDate(endMs) }
}

/** Federal Register query URL. Built by hand: the CRE runtime may lack URLSearchParams. */
export function buildQueryUrl(baseUrl: string, window: { start: string; end: string }, perPage: number): string {
	if (!baseUrl.startsWith('https://')) throw new Error('FR base URL must be https')
	const enc = encodeURIComponent
	const parts = [
		`per_page=${perPage}`,
		'order=newest',
		...FIELDS.map((f) => `${enc('fields[]')}=${f}`),
		`${enc('conditions[term]')}=${enc(SEARCH_TERM)}`,
		`${enc('conditions[publication_date][gte]')}=${window.start}`,
		`${enc('conditions[publication_date][lte]')}=${window.end}`,
	]
	return `${baseUrl}?${parts.join('&')}`
}

/** Canonical string form so the DON can require identical results across nodes. */
export function serializeResult(r: GateResult): string {
	return JSON.stringify({
		windowStart: r.windowStart,
		windowEnd: r.windowEnd,
		statuses: r.statuses,
		triggerDocs: r.triggerDocs,
		matched: r.matched,
		ignored: r.ignored,
		truncated: r.truncated,
	})
}

export function deserializeResult(s: string): GateResult {
	const r = JSON.parse(s) as GateResult
	if (!Array.isArray(r.statuses) || r.statuses.length !== CATEGORIES.length) throw new Error('bad statuses')
	if (!r.statuses.every((x) => x === 0 || x === 1 || x === 2)) throw new Error('bad status value')
	if (!Array.isArray(r.triggerDocs) || r.triggerDocs.length !== CATEGORIES.length) throw new Error('bad triggerDocs')
	return r
}

/**
 * ABI payload for RegGateStatus.sol:
 *   (uint256 chainId, uint64 asOf, uint8[4] statuses, bytes32[4] triggerDocs)
 * chainId and asOf defend against cross-chain and same-chain replay.
 */
export function encodeReport(chainId: bigint, asOf: bigint, r: GateResult): Hex {
	const docs = r.triggerDocs.map((d) => (d === '' ? (`0x${'00'.repeat(32)}` as Hex) : stringToHex(d, { size: 32 })))
	return encodeAbiParameters(
		[
			{ type: 'uint256' },
			{ type: 'uint64' },
			{ type: 'uint8[4]' },
			{ type: 'bytes32[4]' },
		],
		[
			chainId,
			asOf,
			r.statuses as unknown as readonly [number, number, number, number],
			docs as unknown as readonly [Hex, Hex, Hex, Hex],
		],
	)
}

export function summarize(r: GateResult): string {
	const lines = CATEGORIES.map(
		(c, i) => `${c}=${STATUS_NAMES[r.statuses[i]]}${r.triggerDocs[i] ? ` (${r.triggerDocs[i]})` : ''}`,
	)
	return `window ${r.windowStart}..${r.windowEnd} matched=${r.matched} ignored=${r.ignored} truncated=${r.truncated} | ${lines.join(' ')}`
}
