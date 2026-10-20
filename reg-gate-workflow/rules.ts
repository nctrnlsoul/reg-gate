// Reg-Gate classifier rules.
//
// This file has no imports on purpose. The CRE workflow runs it on every DON node,
// and the status page loads the same code (built to docs/rules.js) to explain each
// status. One rule set, two readers.
//
// Pure, deterministic logic: no network, no clock, no randomness. Every node in a
// CRE DON runs this on the same input and must reach the same output, so it
// cannot use an LLM or anything time-dependent.
//
// Fail-closed rules:
//   - A response that does not match the expected shape throws. The workflow then
//     writes nothing, and the on-chain contract treats missing or stale data as BLOCK.
//   - A matched document of an unknown type is BLOCK, not OK.
//   - A final rule with no effective date is treated as already in effect (BLOCK).
//   - A truncated result set (more documents than we received) floors every
//     category at REVIEW, because we cannot vouch for what we did not see.
//
// Timing: a final rule BLOCKs when it takes effect, not when it is published.
// Between publication and its effective date it is REVIEW, so issuers get the
// notice period the agency gave them. A second query finds rules that take effect
// inside the window even when they were published months earlier.
//
// Two narrow exclusions, both anchored on type and title so near misses take the
// normal path: an exchange's own rule filing that the SEC publishes for comment
// (an SRO notice), and an agency withdrawing its own proposal. Neither puts a new
// obligation on an issuer. They are counted as informational, never dropped silently.
//
// Claim boundary: this flags regulatory publications for human review.
// It is not legal advice and does not interpret the law.

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
	effectiveOn: string // YYYY-MM-DD, '' when the API gave none
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
	asOfDate: string // the run's consensus date; effective dates are judged against it
	statuses: StatusCode[] // index matches CATEGORIES
	triggerDocs: string[] // document number behind each status, '' when OK
	blockDocs: string[][] // every document at BLOCK, per category, newest first
	matched: number
	ignored: number
	informational: number // SRO filings and withdrawn proposals: seen, counted, not escalated
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
	'national-credit-union-administration', // a GENIUS Act stablecoin regulator
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

export const FIELDS = [
	'document_number',
	'title',
	'type',
	'publication_date',
	'effective_on',
	'abstract',
	'agencies',
] as const

// Exchange and clearing-agency rule filings. The SEC publishes these for comment
// under the title prefix "Self-Regulatory Organizations;".
const SRO_TITLE = /^self-regulatory organizations;/
// An agency withdrawing a proposal it published earlier: "...; Withdrawal".
const WITHDRAWAL_TITLE = /;\s*withdrawal\.?$/
// FINRA rule filings bind broker-dealers, so they are not treated as informational.
const FINRA = /\bfinancial industry regulatory authority\b/
// Withdrawing an exemption or relief tightens obligations, so it is not informational.
const RELIEF = /\bexempt(ion|ions|ive)?\b|\brelief\b/

// At most this many blocking documents in one report (the contract enforces the same cap).
export const MAX_BLOCK_DOCS = 16
// How far ahead the pending-rule query looks for final rules not yet in effect.
export const EFFECTIVE_HORIZON_DAYS = 366

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
		const eff = r.effective_on
		if (eff !== null && eff !== undefined && eff !== '' && (typeof eff !== 'string' || !DATE_RE.test(eff))) {
			throw new Error(`FR result ${i} has bad effective_on`)
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
			effectiveOn: typeof eff === 'string' ? eff : '',
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

const normType = (doc: FrDocument) => doc.type.trim().toLowerCase()

/**
 * Severity of a matched document as of `asOfDate` (the last finished day).
 * A final rule that has not taken effect yet is REVIEW; one in effect, or with no
 * effective date at all, is BLOCK.
 */
export function severityFor(doc: FrDocument, asOfDate: string): StatusCode {
	if (normType(doc) === 'rule' && doc.effectiveOn !== '' && doc.effectiveOn > asOfDate) return Status.REVIEW
	return severityForType(doc.type)
}

/**
 * Why a document is informational rather than a gate signal, or null if it is not.
 * Both checks are exact on type and title, and the SRO check also requires the SEC
 * to be the only agency, so anything unusual takes the normal path.
 */
export function informationalReason(doc: FrDocument): 'sro-filing' | 'withdrawn-proposal' | null {
	const title = doc.title.trim().toLowerCase()
	const type = normType(doc)
	if (
		type === 'notice' &&
		doc.agencySlugs.length > 0 &&
		doc.agencySlugs.every((s) => s === SEC) &&
		SRO_TITLE.test(title) &&
		!FINRA.test(title)
	) {
		return 'sro-filing'
	}
	if (type === 'proposed rule' && WITHDRAWAL_TITLE.test(title) && !RELIEF.test(title)) return 'withdrawn-proposal'
	return null
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

// ---------------------------------------------------------------------------
// explain(): the same decision, as evidence a person can read.
// The status page runs this (built to docs/rules.js) to show why each status is
// what it is. It must never disagree with classify(); tests hold it to that.
// ---------------------------------------------------------------------------

export interface Evidence {
	category: Category
	term: string // the text that matched, as written in the document (lowercased)
	field: 'title' | 'abstract' | 'agency'
	note?: string // why this match counts, when it needs saying
}

export type Outcome = 'out-of-scope' | 'procedural' | 'no-match' | 'informational' | 'matched'

export interface Explanation {
	documentNumber: string
	agencies: { slug: string; watched: boolean }[]
	outcome: Outcome
	evidence: Evidence[]
	categories: Category[]
	informational: 'sro-filing' | 'withdrawn-proposal' | null
	severity: StatusCode | null // null unless outcome is 'matched'
	severityReason: string
}

/** First pattern that matches the combined text, and which field it fell in. */
function firstMatch(patterns: RegExp[], doc: FrDocument): { term: string; field: 'title' | 'abstract' } | null {
	const title = doc.title.toLowerCase()
	const text = `${title} ${doc.abstract.toLowerCase()}`
	for (const p of patterns) {
		const m = new RegExp(p.source, p.flags.replace('g', '')).exec(text)
		if (m) return { term: m[0], field: m.index < title.length ? 'title' : 'abstract' }
	}
	return null
}

function severityReasonFor(doc: FrDocument, asOfDate: string): string {
	const type = normType(doc)
	if (type === 'rule') {
		if (doc.effectiveOn === '') return 'final rule with no effective date, treated as in effect'
		if (doc.effectiveOn > asOfDate) return `final rule, takes effect ${doc.effectiveOn}`
		return `final rule, in effect since ${doc.effectiveOn}`
	}
	if (type === 'presidential document') return 'presidential document'
	if (type === 'proposed rule') return 'proposed rule'
	if (type === 'notice') return 'notice'
	return `unrecognized document type "${doc.type}", fails closed`
}

/** Why classify() treats this document the way it does, as of `asOfDate` (YYYY-MM-DD). */
export function explain(doc: FrDocument, asOfDate: string): Explanation {
	const agencies = doc.agencySlugs.map((slug) => ({ slug, watched: WATCHED_AGENCIES.has(slug) }))
	const base = {
		documentNumber: doc.documentNumber,
		agencies,
		evidence: [] as Evidence[],
		categories: [] as Category[],
		informational: null,
		severity: null,
		severityReason: severityReasonFor(doc, asOfDate),
	}
	if (isOutOfScope(doc)) return { ...base, outcome: 'out-of-scope' }
	if (isProcedural(doc)) return { ...base, outcome: 'procedural' }

	const evidence: Evidence[] = []
	const stable = firstMatch(STABLECOIN_TERMS, doc)
	if (stable) evidence.push({ category: 'STABLECOINS', ...stable })

	const tok = firstMatch(TOKENIZED_TERMS, doc)
	const secOnly = doc.agencySlugs.includes(SEC) ? firstMatch(SEC_ONLY_TOKENIZED_TERMS, doc) : null
	if (tok) evidence.push({ category: 'TOKENIZED_SECURITIES', ...tok })
	else if (secOnly) evidence.push({ category: 'TOKENIZED_SECURITIES', ...secOnly, note: 'counts only from the SEC' })

	const digital = firstMatch(DIGITAL_ASSET_TERMS, doc)
	if (digital) evidence.push({ category: 'DIGITAL_ASSET_MARKETS', ...digital })

	if (stable || tok || secOnly || digital) {
		const amlAgency = doc.agencySlugs.find((s) => AML_AGENCIES.has(s))
		const amlTerm = firstMatch(AML_TERMS, doc)
		if (amlAgency) {
			evidence.push({ category: 'AML_SANCTIONS', term: amlAgency, field: 'agency', note: 'an AML agency on a digital asset document' })
		} else if (amlTerm) {
			evidence.push({ category: 'AML_SANCTIONS', ...amlTerm, note: 'on a digital asset document' })
		}
	}

	const categories = CATEGORIES.filter((c) => evidence.some((e) => e.category === c))
	if (categories.length === 0) return { ...base, outcome: 'no-match' }
	const info = informationalReason(doc)
	if (info !== null) return { ...base, outcome: 'informational', evidence, categories, informational: info }
	return { ...base, outcome: 'matched', evidence, categories, severity: severityFor(doc, asOfDate) }
}

// Deterministic tie-break: newest publication date first, then document number.
/**
 * The date a document last changed anything: its effective date for a final rule
 * that has taken effect since publication, otherwise its publication date.
 */
export function eventDate(doc: FrDocument, asOfDate: string): string {
	if (normType(doc) === 'rule' && doc.effectiveOn !== '' && doc.effectiveOn <= asOfDate && doc.effectiveOn > doc.publicationDate) {
		return doc.effectiveOn
	}
	return doc.publicationDate
}

const moreRecent = (a: FrDocument, b: FrDocument, asOfDate: string) => {
	const ea = eventDate(a, asOfDate)
	const eb = eventDate(b, asOfDate)
	return ea !== eb ? ea > eb : a.documentNumber > b.documentNumber
}

const EMPTY: ParsedResponse = { count: 0, documents: [] }

/**
 * @param published documents published inside the window
 * @param takingEffect final rules whose effective date falls inside the window,
 *   whatever their publication date (the second query)
 */
export function classify(
	published: ParsedResponse,
	windowStart: string,
	windowEnd: string,
	takingEffect: ParsedResponse = EMPTY,
	asOfDate: string = windowEnd,
	horizon: string = asOfDate,
): GateResult {
	const statuses: StatusCode[] = CATEGORIES.map(() => Status.OK)
	const triggers: (FrDocument | null)[] = CATEGORIES.map(() => null)
	const blocking: FrDocument[][] = CATEGORIES.map(() => [])
	let matched = 0
	let ignored = 0
	let informational = 0

	// Each query already bounds its window; enforce it again rather than trust it.
	for (const doc of published.documents) {
		if (doc.publicationDate < windowStart || doc.publicationDate > windowEnd) {
			throw new Error(`FR document ${doc.documentNumber} outside requested window`)
		}
	}
	for (const doc of takingEffect.documents) {
		if (normType(doc) !== 'rule') {
			throw new Error(`FR document ${doc.documentNumber} from the effective-date query is not a final rule`)
		}
		if (doc.effectiveOn === '' || doc.effectiveOn < windowStart || doc.effectiveOn > horizon) {
			throw new Error(`FR document ${doc.documentNumber} does not take effect in the requested window`)
		}
	}

	// A rule published and taking effect in the same window comes back from both queries.
	const seen = new Set<string>()
	const docs: FrDocument[] = []
	for (const doc of [...published.documents, ...takingEffect.documents]) {
		if (seen.has(doc.documentNumber)) continue
		seen.add(doc.documentNumber)
		docs.push(doc)
	}

	for (const doc of docs) {
		if (isOutOfScope(doc) || isProcedural(doc)) {
			ignored++
			continue
		}
		const cats = categoriesFor(doc)
		if (cats.length === 0) {
			ignored++
			continue
		}
		if (informationalReason(doc) !== null) {
			informational++
			continue
		}
		matched++
		const sev = severityFor(doc, asOfDate)
		for (const cat of cats) {
			const i = CATEGORIES.indexOf(cat)
			const current = triggers[i]
			if (sev > statuses[i] || (sev === statuses[i] && current !== null && moreRecent(doc, current, asOfDate))) {
				statuses[i] = sev
				triggers[i] = doc
			}
			if (sev === Status.BLOCK) blocking[i].push(doc)
		}
	}

	// Every blocking document goes on-chain, so each one needs its own human review.
	const blockDocs = blocking.map((list) =>
		list
			.slice()
			.sort((a, b) => (moreRecent(a, b, asOfDate) ? -1 : moreRecent(b, a, asOfDate) ? 1 : 0))
			.map((d) => d.documentNumber),
	)
	const total = blockDocs.reduce((n, l) => n + l.length, 0)
	if (total > MAX_BLOCK_DOCS) {
		// A partial list could let an unlisted document escape review. Write nothing;
		// the contract's staleness rule turns that silence into BLOCK.
		throw new Error(`${total} blocking documents exceed the report cap of ${MAX_BLOCK_DOCS}`)
	}

	// A result set larger than one page: we cannot vouch for what we did not see,
	// and an unseen document could be a final rule in effect. Floor at BLOCK.
	const truncated =
		published.count > published.documents.length || takingEffect.count > takingEffect.documents.length
	if (truncated) {
		for (let i = 0; i < statuses.length; i++) statuses[i] = Status.BLOCK
	}

	return {
		windowStart,
		windowEnd,
		asOfDate,
		statuses,
		triggerDocs: triggers.map((d) => (d ? d.documentNumber : '')),
		blockDocs,
		matched,
		ignored,
		informational,
		truncated,
	}
}

const DAY_MS = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export interface Window {
	start: string // first day of publications looked at
	end: string // last finished day of publications (yesterday)
	today: string // the run's own date: effective dates are fixed, so today is safe to judge
	horizon: string // the pending-rule query looks this far ahead for rules not yet in effect
}

/**
 * Publication window ending the day before the run. Using yesterday, not today,
 * keeps every node on the same finished day of publications, so they agree.
 * Effective dates are printed in the document and never change, so they are
 * judged against today, and pending rules are looked up to a year ahead.
 */
export function computeWindow(scheduledUnixSeconds: number, lookbackDays: number): Window {
	if (!Number.isInteger(scheduledUnixSeconds) || scheduledUnixSeconds <= 0) {
		throw new Error('scheduled time must be a positive integer')
	}
	if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
		throw new Error('lookbackDays must be an integer from 1 to 90')
	}
	const dayStart = Math.floor((scheduledUnixSeconds * 1000) / DAY_MS) * DAY_MS
	const endMs = dayStart - DAY_MS
	return {
		start: isoDate(endMs - (lookbackDays - 1) * DAY_MS),
		end: isoDate(endMs),
		today: isoDate(dayStart),
		horizon: isoDate(dayStart + EFFECTIVE_HORIZON_DAYS * DAY_MS),
	}
}

/** Federal Register query URL. Built by hand: the CRE runtime may lack URLSearchParams. */
function queryUrl(baseUrl: string, perPage: number, conditions: string[]): string {
	if (!baseUrl.startsWith('https://')) throw new Error('FR base URL must be https')
	const enc = encodeURIComponent
	const parts = [
		`per_page=${perPage}`,
		'order=newest',
		...FIELDS.map((f) => `${enc('fields[]')}=${f}`),
		`${enc('conditions[term]')}=${enc(SEARCH_TERM)}`,
		...conditions,
	]
	return `${baseUrl}?${parts.join('&')}`
}

/** Documents published inside the window. */
export function buildQueryUrl(baseUrl: string, window: { start: string; end: string }, perPage: number): string {
	const enc = encodeURIComponent
	return queryUrl(baseUrl, perPage, [
		`${enc('conditions[publication_date][gte]')}=${window.start}`,
		`${enc('conditions[publication_date][lte]')}=${window.end}`,
	])
}

/** Final rules that take effect inside the window, whenever they were published. */
export function buildEffectiveQueryUrl(
	baseUrl: string,
	window: { start: string; horizon: string },
	perPage: number,
): string {
	const enc = encodeURIComponent
	return queryUrl(baseUrl, perPage, [
		`${enc('conditions[type][]')}=RULE`,
		`${enc('conditions[effective_date][gte]')}=${window.start}`,
		`${enc('conditions[effective_date][lte]')}=${window.horizon}`,
	])
}

/** Canonical string form so the DON can require identical results across nodes. */
export function serializeResult(r: GateResult): string {
	return JSON.stringify({
		windowStart: r.windowStart,
		windowEnd: r.windowEnd,
		asOfDate: r.asOfDate,
		statuses: r.statuses,
		triggerDocs: r.triggerDocs,
		blockDocs: r.blockDocs,
		matched: r.matched,
		ignored: r.ignored,
		informational: r.informational,
		truncated: r.truncated,
	})
}

export function deserializeResult(s: string): GateResult {
	const r = JSON.parse(s) as GateResult
	if (!Array.isArray(r.statuses) || r.statuses.length !== CATEGORIES.length) throw new Error('bad statuses')
	if (!r.statuses.every((x) => x === 0 || x === 1 || x === 2)) throw new Error('bad status value')
	if (!Array.isArray(r.triggerDocs) || r.triggerDocs.length !== CATEGORIES.length) throw new Error('bad triggerDocs')
	for (const k of ['matched', 'ignored', 'informational'] as const) {
		if (!Number.isInteger(r[k]) || r[k] < 0) throw new Error(`bad ${k}`)
	}
	if (!Array.isArray(r.blockDocs) || r.blockDocs.length !== CATEGORIES.length) throw new Error('bad blockDocs')
	let total = 0
	r.blockDocs.forEach((list, i) => {
		if (!Array.isArray(list) || !list.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 32)) {
			throw new Error('bad blockDocs entry')
		}
		if (list.length > 0 && r.statuses[i] !== Status.BLOCK) throw new Error('blockDocs on a category not at BLOCK')
		total += list.length
	})
	if (total > MAX_BLOCK_DOCS) throw new Error('too many blockDocs')
	return r
}

export function summarize(r: GateResult): string {
	const lines = CATEGORIES.map(
		(c, i) => `${c}=${STATUS_NAMES[r.statuses[i]]}${r.triggerDocs[i] ? ` (${r.triggerDocs[i]})` : ''}`,
	)
	const blocking = r.blockDocs.reduce((n, l) => n + l.length, 0)
	return `window ${r.windowStart}..${r.windowEnd} asOf=${r.asOfDate} blocking=${blocking} matched=${r.matched} ignored=${r.ignored} informational=${r.informational} truncated=${r.truncated} | ${lines.join(' ')}`
}
