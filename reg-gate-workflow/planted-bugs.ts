// Planted bugs: break one line of production code at a time and confirm a test fails.
// A bug that no test catches is a missing test. Every line here was a real question
// asked of the code, several by the 2026-10-20 independent audit.
//
//   bun planted-bugs.ts            # workflow and contract bugs (contracts need forge on PATH)
//   bun planted-bugs.ts workflow   # workflow only
//
// Each bug is applied to the working tree, tested, and reverted in a finally block.
// Exit code 1 if any bug survives.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Bug = { file: string; find: string; replace: string; name: string }

const W = (file: string) => join(import.meta.dir, file)
const C = (file: string) => join(import.meta.dir, '..', 'contracts', 'src', file)

const workflow: Bug[] = [
	// Parser and classifier (rules.ts)
	{ file: W('rules.ts'), find: "if (!isNonEmptyString(r.type)) throw new Error(`FR result ${i} missing type`)", replace: '', name: 'Parser accepts a document with no type' },
	{ file: W('rules.ts'), find: "throw new Error(`FR result ${i} has bad effective_on`)", replace: '', name: 'Parser accepts a malformed effective date' },
	{ file: W('rules.ts'), find: "if (obj.count !== 0) throw new Error('FR response missing results with nonzero count')", replace: '', name: 'Missing results with a nonzero count reads as empty' },
	{ file: W('rules.ts'), find: "		default:\n			return Status.BLOCK", replace: "		default:\n			return Status.OK", name: 'Unknown document type reads OK' },
	{ file: W('rules.ts'), find: "if (normType(doc) === 'rule' && doc.effectiveOn !== '' && doc.effectiveOn > asOfDate) return Status.REVIEW", replace: "if (normType(doc) === 'rule' && doc.effectiveOn >= '') return Status.REVIEW", name: 'Final rule with no effective date reads as pending' },
	{ file: W('rules.ts'), find: "doc.effectiveOn > asOfDate) return Status.REVIEW", replace: "doc.effectiveOn >= asOfDate) return Status.REVIEW", name: 'A rule taking effect today reads as pending' },
	{ file: W('rules.ts'), find: "doc.agencySlugs.every((s) => s === SEC) &&", replace: '', name: 'SRO exclusion ignores other agencies' },
	{ file: W('rules.ts'), find: "		!FINRA.test(title) &&\n", replace: "", name: 'FINRA filings treated as informational' },
	{ file: W('rules.ts'), find: "		!SRO_IN_FORCE.test(title) &&\n", replace: "", name: 'An approved or immediately effective SRO filing treated as informational' },
	{ file: W('rules.ts'), find: "		!anyMatch(TOKENIZED_TERMS, `${title} ${doc.abstract} ${doc.excerpts}`.toLowerCase()) &&\n", replace: "		true &&\n", name: 'An exchange filing on tokenized securities treated as informational' },
	{ file: W('rules.ts'), find: "		!anyMatch(SEC_ONLY_TOKENIZED_TERMS, `${title} ${doc.abstract} ${doc.excerpts}`.toLowerCase())\n", replace: "		true\n", name: 'An exchange filing under Regulation Crypto treated as informational' },
	{ file: W('rules.ts'), find: "if (type === 'proposed rule' && WITHDRAWAL_TITLE.test(title) && !RELIEF.test(title))", replace: "if (WITHDRAWAL_TITLE.test(title))", name: 'Any withdrawal treated as informational' },
	{ file: W('rules.ts'), find: "const WITHDRAWAL_TITLE = /;\\s*withdrawal\\.?$/", replace: "const WITHDRAWAL_TITLE = /;\\s*withdrawal/", name: 'Withdrawal pattern unanchored' },
	{ file: W('rules.ts'), find: "const SRO_TITLE = /^self-regulatory organizations;/", replace: "const SRO_TITLE = /self-regulatory organizations;/", name: 'SRO pattern unanchored' },
	{ file: W('rules.ts'), find: "const PROCEDURAL_TITLES = [/^agenda$/,", replace: "const PROCEDURAL_TITLES = [/agenda/,", name: 'Procedural pattern unanchored' },
	{ file: W('rules.ts'), find: "	'national-credit-union-administration', // a GENIUS Act stablecoin regulator\n", replace: '', name: 'NCUA dropped from watched agencies' },
	{ file: W('rules.ts'), find: "	if (doc.agencySlugs.some((s) => s === '')) return false", replace: '', name: 'Missing agency slug treated as out of scope' },
	{ file: W('rules.ts'), find: "if (doc.publicationDate < windowStart || doc.publicationDate > windowEnd) {", replace: "if (false) {", name: 'Publication window not enforced' },
	{ file: W('rules.ts'), find: "if (doc.effectiveOn === '' || doc.effectiveOn < windowStart || doc.effectiveOn > horizon) {", replace: "if (false) {", name: 'Pending-rule window not enforced' },
	{ file: W('rules.ts'), find: "		if (normType(doc) !== 'rule') {", replace: "		if (false) {", name: 'Pending-rule query accepts non-rules' },
	{ file: W('rules.ts'), find: "		if (seen.has(doc.documentNumber)) continue\n", replace: '', name: 'A rule from both queries is counted twice' },
	{ file: W('rules.ts'), find: "		if (informationalReason(doc) !== null) {", replace: "		if (false) {", name: 'Informational exclusions switched off' },
	{ file: W('rules.ts'), find: "			if (sev === Status.BLOCK) blocking[i].push(doc)", replace: '', name: 'Blocking documents not listed' },
	{ file: W('rules.ts'), find: "		incomplete[c] = true\n", replace: "", name: 'Over-cap blocking list written partially, with no placeholder' },
	{ file: W('rules.ts'), find: "		if (seen.has(d.documentNumber)) duplicates++\n		else {", replace: "		{", name: 'A repeated document in a response goes unnoticed' },
	{ file: W('rules.ts'), find: "const text = `${doc.title} ${doc.abstract} ${doc.excerpts}`.toLowerCase()\n\tconst isStablecoin", replace: "const text = `${doc.title} ${doc.abstract}`.toLowerCase()\n\tconst isStablecoin", name: 'Body text (excerpts) ignored' },
	{ file: W('rules.ts'), find: "		.replace(/<[^>]*>/g, ' ')\n", replace: "", name: 'Excerpt markup not stripped' },
	{ file: W('rules.ts'), find: "/\\bdigital[\\s-]+assets?\\b/,", replace: "/\\bdigital assets?\\b/,", name: 'Hyphenated spelling missed' },
	{ file: W('workflow.ts'), find: "if (resp.receiverContractExecutionStatus === RECEIVER_REVERTED) {", replace: "if (false) {", name: 'A report the contract rejected is logged as written' },
	{ file: W('workflow.ts'), find: "lookbackDays: z.number().int().min(14).max(90)", replace: "lookbackDays: z.number().int().min(1).max(90)", name: 'A lookback shorter than the gap rule accepted' },
	{ file: W('rules.ts'), find: "		statuses[i] = Status.BLOCK\n		blockDocs[i].unshift(placeholder)", replace: "		if (statuses[i] < Status.REVIEW) statuses[i] = Status.REVIEW\n		blockDocs[i].unshift(placeholder)", name: 'Truncation floors at REVIEW, not BLOCK' },
	{ file: W('rules.ts'), find: "const truncated = faulty(published) || faulty(takingEffect)", replace: "const truncated = faulty(published)", name: 'Truncated pending-rule query ignored' },
	{ file: W('rules.ts'), find: "r.count !== r.documents.length || r.duplicates > 0", replace: "r.count > r.documents.length", name: 'A faulty response (repeats, or more documents than counted) passes as complete' },
	{ file: W('rules.ts'), find: "		`${enc('conditions[publication_date][lte]')}=${window.end}`,\n	])\n}\n\n/** Canonical", replace: "	])\n}\n\n/** Canonical", name: 'Pending-rule query reads the still-posting issue' },
	{ file: W('rules.ts'), find: "		if (doc.publicationDate > windowEnd) {", replace: "		if (false) {", name: 'Pending rule published after the window accepted' },
	{ file: W('rules.ts'), find: "	return ea !== eb ? ea > eb : a.documentNumber > b.documentNumber", replace: "	return a.publicationDate !== b.publicationDate ? a.publicationDate > b.publicationDate : a.documentNumber > b.documentNumber", name: 'Trigger chosen by publication date, not event date' },
	{ file: W('rules.ts'), find: "		today: isoDate(dayStart),", replace: "		today: isoDate(endMs),", name: 'Effective dates judged against yesterday' },
	{ file: W('rules.ts'), find: "if (list.length > 0 && r.statuses[i] !== Status.BLOCK) throw new Error('blockDocs on a category not at BLOCK')", replace: '', name: 'Deserializer accepts documents on a non-BLOCK category' },
	{ file: W('rules.ts'), find: "		if (m) return { term: m[0], field: m.index < title.length ? 'title' : m.index <= title.length + abstract.length ? 'abstract' : 'excerpt' }", replace: "		if (m) return { term: m[0], field: 'title' }", name: 'explain() attributes every match to the title' },
	// Heartbeat (regGate.ts)
	{ file: W('regGate.ts'), find: "if (onChain === null) return { write: true, reason: 'on-chain read failed' }", replace: "if (onChain === null) return { write: false, reason: 'x' }", name: 'Unreadable chain treated as unchanged' },
	{ file: W('regGate.ts'), find: "if (onChain.lastAsOf === 0n) return { write: true, reason: 'no report on-chain yet' }", replace: '', name: 'Empty contract treated as unchanged' },
	{ file: W('regGate.ts'), find: "		return { write: true, reason: 'blocking documents changed' }", replace: "		return { write: false, reason: 'x' }", name: 'Blocking-document change ignored' },
	{ file: W('regGate.ts'), find: "const limit = heartbeatSeconds < quarterMaxAge ? heartbeatSeconds : quarterMaxAge", replace: "const limit = heartbeatSeconds", name: 'Heartbeat not capped by maxAge' },
	{ file: W('regGate.ts'), find: "const quarterMaxAge = onChain.maxAge / 4n", replace: "const quarterMaxAge = onChain.maxAge / 2n", name: 'Heartbeat cap too loose for a late clock' },
	{ file: W('regGate.ts'), find: "if (age >= limit)", replace: "if (age > limit)", name: 'Heartbeat off by one second' },
	// Workflow wiring (workflow.ts)
	{ file: W('workflow.ts'), find: "if (response.statusCode !== 200) {", replace: "if (false) {", name: 'HTTP error status ignored' },
	{ file: W('workflow.ts'), find: "const takingEffect = parseFederalRegisterResponse(fetchBody(sendRequester, args.effectiveUrl))", replace: "const takingEffect = { count: 0, documents: [] }", name: 'Pending-rule query skipped' },
	{ file: W('workflow.ts'), find: "	if (latest.write) return { write: true, reason: `${latest.reason} (latest block)` }", replace: '', name: 'Latest-block state ignored' },
	{ file: W('workflow.ts'), find: "	if (finalized.write) return { write: true, reason: `${finalized.reason} (finalized block)` }", replace: '', name: 'Finalized-block state ignored' },
	{ file: W('workflow.ts'), find: "const report = encodeReport(BigInt(network.chainId), BigInt(asOf), result)", replace: "const report = encodeReport(11155111n, BigInt(asOf), result)", name: 'Mirror report bound to the wrong chain' },
	{ file: W('workflow.ts'), find: "	if (failed.length > 0) {", replace: "	if (false) {", name: 'Failed chain write swallowed' },
	{ file: W('workflow.ts'), find: "if (resp.txStatus !== TxStatus.SUCCESS) {", replace: "if (false) {", name: 'Reverted write reported as success' },
	{ file: W('workflow.ts'), find: "	if (!receivers.includes(emitter)) {", replace: "	if (false) {", name: 'LatchCleared from any contract accepted' },
	{ file: W('workflow.ts'), find: "	if (log.removed) throw new Error('Refusing a log that was removed by a reorg')", replace: '', name: 'Reorged-out LatchCleared accepted' },
	{ file: W('workflow.ts'), find: "confidence: 'SAFE',", replace: "confidence: 'LATEST',", name: 'LatchCleared trigger reads unconfirmed blocks' },
	{ file: W('workflow.ts'), find: ".refine((u) => u === FR_DOCUMENTS_URL,", replace: ".refine((u) => u.startsWith(FR_DOCUMENTS_URL),", name: 'Federal Register URL accepts a suffix' },
	{ file: W('workflow.ts'), find: "			return new Set(names).size === names.length", replace: "			return true", name: 'Same chain allowed twice' },
	{ file: W('workflow.ts'), find: "const asOf = Math.floor(runtime.now().getTime() / 1000)", replace: "const asOf = Math.floor(Date.now() / 1000)", name: 'Report stamped with the node clock, not DON time' },
]

const contracts: Bug[] = [
	{ file: C('RegGateStatus.sol'), find: 'if (msg.sender != forwarder) revert InvalidSender(msg.sender);', replace: '', name: 'Anyone can write reports' },
	{ file: C('RegGateStatus.sol'), find: 'if (author != pinned) revert InvalidAuthor(author);', replace: '', name: 'Any workflow owner accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (!simulation) revert AuthorNotSet();', replace: '', name: 'Production accepts reports with no author pinned' },
	{ file: C('RegGateStatus.sol'), find: 'if (author_ == address(0) && !simulation_) revert AuthorNotSet();', replace: '', name: 'Production deploys with no author' },
	{ file: C('RegGateStatus.sol'), find: '        if (author == address(0)) revert ZeroAddress();\n        expectedAuthor = author;', replace: '        expectedAuthor = author;', name: 'Author can be unpinned' },
	{ file: C('RegGateStatus.sol'), find: 'if (chainId != block.chainid) revert WrongChain(chainId);', replace: '', name: 'Cross-chain replay accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (asOf <= lastAsOf) revert StaleOrReplayed(asOf, lastAsOf);', replace: '', name: 'Same-chain replay accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (asOf > block.timestamp + MAX_FUTURE_SKEW) revert FutureReport(asOf);', replace: '', name: 'Far-future report accepted' },
	{ file: C('RegGateStatus.sol'), find: '|| report.length != 32 * (14 + 2 * n)', replace: '', name: 'Trailing report bytes accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (blockDocs[j] == bytes32(0) || statuses[c] != BLOCK) revert InvalidReport();', replace: '', name: 'Inconsistent blocking list accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (statuses[i] > BLOCK) revert InvalidStatus(i, statuses[i]);', replace: '', name: 'Out-of-range status accepted' },
	{ file: C('RegGateStatus.sol'), find: 'if (lastAsOf == 0 || block.timestamp > uint256(lastAsOf) + maxAge) return BLOCK;', replace: 'if (lastAsOf == 0) return BLOCK;', name: 'Stale report not BLOCK' },
	{ file: C('RegGateStatus.sol'), find: 'if (_latched[category]) return BLOCK;', replace: '', name: 'Latch ignored' },
	{ file: C('RegGateStatus.sol'), find: '        if (_pending[category].length > 0) return BLOCK;', replace: '', name: 'Unreviewed blocking document reads REVIEW' },
	{ file: C('RegGateStatus.sol'), find: '        if (_blockDocs[category].length == 0) return BLOCK;', replace: '', name: 'BLOCK with no document reads REVIEW' },
	{ file: C('RegGateStatus.sol'), find: '        _latchNext(category, false);', replace: '', name: 'Clearing one document does not latch the next' },
	{ file: C('RegGateStatus.sol'), find: '        _latchNext(category, false);', replace: '        if (_reported[category] == BLOCK) _latchNext(category, false);', name: 'A queued document is forgotten once a report stops listing it' },
	{ file: C('RegGateStatus.sol'), find: '            _enqueue(c, blockDocs[j]);', replace: '', name: 'Blocking documents never queued for review' },
	{ file: C('RegGateStatus.sol'), find: 'if (_reviewed[category][doc] || _queued[category][doc]) return;', replace: 'if (_queued[category][doc]) return;', name: 'A reviewed document is queued again' },
	{ file: C('RegGateStatus.sol'), find: 'if (_pending[category].length >= MAX_PENDING) revert ReviewQueueFull(category);', replace: '', name: 'Review queue unbounded' },
	{ file: C('RegGateStatus.sol'), find: 'bool coverageGap = lastAsOf != 0 && asOf > lastAsOf + MAX_REPORT_GAP;', replace: 'bool coverageGap = false;', name: 'A gap longer than the search window reads OK at once' },
	{ file: C('RegGateStatus.sol'), find: 'if (doc != COVERAGE_GAP) _reviewed[category][doc] = true;', replace: '_reviewed[category][doc] = true;', name: 'The gap marker counts as reviewed forever' },
	{ file: C('RegGateStatus.sol'), find: 'if (doc != expectedDoc) revert LatchedDocMismatch(doc);', replace: '', name: 'Clear acknowledges a document nobody named' },
	{ file: C('RegGateStatus.sol'), find: 'if (msg.sender != reviewer) revert NotReviewer();', replace: '', name: 'Anyone can clear a latch' },
	{ file: C('RegGateStatus.sol'), find: 'if (msg.sender != owner) revert NotOwner();', replace: '', name: 'Anyone can administer' },
	{ file: C('RegGateStatus.sol'), find: 'if (msg.sender != pendingOwner) revert NotPendingOwner();', replace: '', name: 'Anyone can accept ownership' },
	{ file: C('GatedToken.sol'), find: 'if (!gate.isAllowed(category, strict)) {', replace: 'if (false) {', name: 'Token skips the gate' },
	{ file: C('RegGateStatus.sol'), find: 'return strict ? s == OK : s != BLOCK;', replace: 'return s != BLOCK;', name: 'Strict token passes on REVIEW' },
	{ file: C('GatedToken.sol'), find: 'if (bal < value) revert InsufficientBalance();', replace: '', name: 'Balance not checked' },
	{ file: C('GatedToken.sol'), find: 'if (allowed < value) revert InsufficientAllowance();', replace: '', name: 'Allowance not checked' },
	{ file: C('GatedToken.sol'), find: 'if (to == address(0)) revert ZeroAddress();', replace: '', name: 'Transfer to the zero address allowed' },
]

function run(cmd: string, args: string[], cwd: string): boolean {
	return spawnSync(cmd, args, { cwd, stdio: 'ignore', env: { ...process.env, PLANTED_BUGS: '1' } }).status === 0
}

function check(bugs: Bug[], test: () => boolean, label: string): number {
	let survived = 0
	console.log(`\n${label}`)
	for (const b of bugs) {
		const src = readFileSync(b.file, 'utf-8')
		const hits = src.split(b.find).length - 1
		if (hits !== 1) {
			console.log(`  ANCHOR  ${b.name} (found ${hits} times; update this script)`)
			survived++
			continue
		}
		try {
			writeFileSync(b.file, src.replace(b.find, b.replace))
			const caught = !test()
			if (!caught) survived++
			console.log(`  ${caught ? 'caught  ' : 'SURVIVED'} ${b.name}`)
		} finally {
			writeFileSync(b.file, src)
		}
	}
	console.log(`  ${bugs.length - survived} of ${bugs.length} caught`)
	return survived
}

const onlyWorkflow = process.argv[2] === 'workflow'
// PLANTED_BUGS=1 skips the docs/rules.js byte comparison, which would flag any rules.ts
// edit. A bug counts as caught only if a behavioral assertion fails.
let survived = check(workflow, () => run('bun', ['test'], import.meta.dir), 'Workflow (bun test)')

if (!onlyWorkflow) {
	const forge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0
	if (!forge) console.log('\nContracts: forge not on PATH, skipped')
	else {
		// FORGE_FLAGS lets an offline machine point forge at a local solc, e.g. "--offline --use /path/solc".
		const flags = (process.env.FORGE_FLAGS ?? '').split(' ').filter(Boolean)
		survived += check(contracts, () => run('forge', ['test', ...flags], join(import.meta.dir, '..', 'contracts')), 'Contracts (forge test)')
	}
}
process.exit(survived === 0 ? 0 : 1)
