# Reg-Gate engineering notes

The detail behind the [README](README.md): classification rules, every fail-closed case, the
security review, the review history of live documents, earlier deployments, and how it was
verified.

## Classification rules

[`reg-gate-workflow/rules.ts`](reg-gate-workflow/rules.ts) sorts documents into
`STABLECOINS`, `TOKENIZED_SECURITIES`, `DIGITAL_ASSET_MARKETS` and `AML_SANCTIONS`.

| Document | Status |
|---|---|
| Final Rule in effect (judged against the run's own date), or with no effective date | `BLOCK` |
| Final Rule not yet in effect, up to a year ahead | `REVIEW` |
| Presidential Document | `BLOCK` |
| Proposed Rule, Notice | `REVIEW` |
| An exchange's own rule filing that the SEC publishes for comment (SRO notice), except FINRA | informational |
| An agency withdrawing its own proposal, unless it withdraws an exemption or relief | informational |
| Anything else | `BLOCK` (unknown fails closed) |
| More results than one page holds, on either query, or a faulty response | every category `BLOCK`, plus a dated `INCOMPLETE` entry |

The classifier reads the title, the abstract, and the excerpts the Federal Register returns
around each body match of the search term. A final rule blocks when it takes effect, not when it is published, so issuers get the
notice period the agency gave them. Informational documents are counted in every run's log
but never move a status: neither kind puts a new obligation on an issuer. The type must match
exactly. The title must match an anchored pattern: the SRO prefix at the start, "; Withdrawal"
at the end. The SRO check also requires the SEC to be the only agency. A near miss takes the
normal path.

**Queries.** Documents published in a 14-day window ending yesterday, and final rules whose
effective date falls between the window start and a year ahead, published no later than
yesterday. Today's issue can still be posting, so leaving it out keeps every node on the same
documents. A rule published today is picked up tomorrow.

**Per-document review.** The report lists every document at `BLOCK`, not only the newest. A
report holds at most 16; when there are more, the newest are listed and the category also gets
a dated `INCOMPLETE` entry, so a reviewer signs off on the documents left out. Every listed
document joins that category's review queue on-chain (at most 64 waiting). While the queue is
not empty, the category reads `BLOCK`, even if later reports say `OK` or the document has left
the search window. The reviewer clears the front of the queue by document number, and the next
one latches straight away. When every listed document has been reviewed, `BLOCK` reads as
`REVIEW`.

**Coverage gap.** If a report arrives more than 14 days after the last one, the search windows
no longer overlap and days went unsearched. Every category then gets a `COVERAGE-GAP` entry in
its queue and stays `BLOCK` until a reviewer clears it.

**Why this status.** The status page explains each category with `explain()` from `rules.ts`,
built to `docs/rules.js`. The page fetches the trigger document and runs it through the same
parser and rules. A test holds `explain()` to `classify()` across every fixture, and CI fails
if `docs/rules.js` differs from a fresh build. Every status the page shows is read from the
contract; the page only explains it.

## Fail-closed cases

| Situation | Result |
|---|---|
| API down, bad JSON, unexpected shape, node disagreement | Nothing written. After `maxAge` (7 days) the contract reads `BLOCK`. |
| Error status with a body that parses as "no results" | Rejected. Never reported as all-OK. |
| Document outside the requested window, on either query | Run aborts. The API response is not trusted. |
| No report ever received, or the last one older than `maxAge` | `BLOCK` |
| Matched document of unknown type | `BLOCK` |
| Final rule with no effective date | `BLOCK` (treated as already in effect) |
| More results than one page holds, a repeated document, or more documents than counted | Every category `BLOCK`, plus an `INCOMPLETE` entry to review |
| More than 16 blocking documents at once | The newest 16 are listed; those categories also get an `INCOMPLETE` entry |
| Blocking document not yet reviewed | `BLOCK`, through later `OK` reports and after it leaves the window, until a human clears that document |
| More than 64 documents waiting in one category | Report rejected (`ReviewQueueFull`); the category already reads `BLOCK` |
| Reports resume after more than 14 days | Every category held for a `COVERAGE-GAP` review |
| The contract rejects a report | The workflow records a failed delivery, not a success |
| Second blocking document arrives while one is latched | Latched as soon as the first is cleared |
| Reviewer clears with the wrong document named | Rejected (`LatchedDocMismatch`) |
| All blocking documents reviewed, still in the window | `REVIEW`, never `OK` |
| Trigger log from another contract, another event, or reorged out | Refused. Nothing fetched, nothing written. |
| Out-of-order or replayed report | Rejected: strictly increasing timestamp, at most 2 minutes ahead of block time |
| A report replayed on the other chain | Rejected: every payload carries its own chain ID |
| Malformed report (trailing bytes, inconsistent lists) | Rejected (`InvalidReport`) |
| On-chain read fails, or latest and finalized disagree | Treated as changed: the report is written |
| Heartbeat set longer than the contract's `maxAge` allows | Capped at a quarter of `maxAge` |
| One chain's write fails or throws | The other chain is still written; the run fails loudly; the failed chain goes stale, then `BLOCK` |
| Production contract with no workflow owner pinned | Cannot be deployed, and refuses every report |
| Status page cannot reach the chain, or the chain returns implausible values | Shows `UNKNOWN`, never `OK` |
| Status page link with a custom RPC (`?rpc=`) | Only localhost is honored, and the page then shows a "Test RPC, not live" banner |

**Write access.** Reports are accepted only from the Chainlink forwarder, from the pinned
workflow owner (production), for this chain, with a strictly increasing timestamp. That covers
the two replay risks in Chainlink's consumer-contract docs: cross-chain replay and same-chain
replay of a failed report. Ownership moves in two steps (`transferOwnership`, then
`acceptOwnership`), and the author pin cannot be set to zero.

**What the owner can do.** The owner can change the pinned workflow owner and the reviewer at
once, with no timelock, and the contract checks the workflow owner, not the workflow ID. Both
are fine for a testnet demo; production should use a multisig owner and pin the workflow ID
too. In simulation mode the forwarder checks no signatures, so anyone can write a report.

## Review before v3 (2026-10-26)

Three independent reviews of the contract, workflow and page, plus Slither and Aderyn. Slither
and Aderyn found no exploitable issue; Aderyn's owner-centralization note is the disclosure
above. Every finding below is fixed and tested.

| Finding | Fix | Test |
|---|---|---|
| A blocking document that left the window before review was forgotten, and the category could reopen | On-chain review queue: listed documents stay queued until cleared | `test_queuedDocumentLeavingWindowStillNeedsReview` |
| A gap of more than 14 days between reports left days unsearched | `COVERAGE-GAP` entry in every category | `test_coverageGapHoldsEveryCategoryForReview` |
| More than 16 blocking documents wrote nothing, so the contract went stale quietly | Newest 16 listed, plus an `INCOMPLETE` entry | `overflow and truncation together still fit one report` |
| A truncated result had no document for a reviewer to sign off | Dated `INCOMPLETE` entry | `truncated results floor every category at BLOCK` |
| A rule mentioning digital assets only in its body read `OK` | Search excerpts are classified too | `a body-only match counts through the excerpts` |
| Spelling variants missed ("stable coin", "tokenizing", "virtual asset") | Wider patterns and search terms | `spelling variants match` |
| SEC approval orders, MSRB filings and safe-harbor withdrawals treated as background | No longer informational | `an SEC order approving a filing ... is not informational` |
| A repeated document in one response went unnoticed | Counts as incomplete | `a repeated document in one response marks the result incomplete` |
| A report the contract rejected was logged as delivered | Receiver status checked | `a report the contract rejected is a failed delivery` |
| Report gas could exceed the configured limit | Limit raised to 2,500,000; worst case measured | `test_worstCaseReportGas` |

## Security review before v2 (2026-10-20)

Before the v2 deployment, four AI review agents, each started without any context on the
project, reviewed the contracts, the workflow, the status page, and the repository. Every
finding below was fixed, and each has a test.

| Finding | Fix | Test |
|---|---|---|
| A second blocking document could go unreviewed: only one document per category was tracked | Reports list every blocking document; the contract needs a human clear for each, naming it | `test_documentArrivingDuringLatchIsLatchedAfterClear`, `test_unreviewedDocumentBehindReviewedTriggerLatches` |
| A rule taking effect today read `REVIEW` (or `OK` if published before the window) for a day | Effective dates judged against the run's own date | `a rule taking effect today reads BLOCK today` |
| Notice periods longer than the lookback read `OK` until the rule took effect | Effective-date query reaches a year ahead | `a rule published long before the window and pending for months reads REVIEW` |
| A truncated result set floored at `REVIEW`, which lenient tokens pass | Floors at `BLOCK` | `truncated results floor every category at BLOCK` |
| The heartbeat read only the finalized block, so it could skip on stale data | Skips only if latest and finalized both match | `latest block holds a newer, different write` |
| The author pin was optional and could be unset | Production requires an author at deploy; the setter rejects zero; simulation mode is an explicit, immutable flag | `test_constructorRejectsZeroAddressesAndMissingAuthor`, `test_authorCannotBeUnpinned` |
| A far-future report could lock out on-time ones for 15 minutes | Skew cut to 2 minutes | `test_futureSkewBoundary` |
| Single-step ownership transfer; trailing report bytes accepted | Two-step ownership; exact report length | `test_twoStepOwnership`, `test_rejectsMalformedReports` |
| `?rpc=https://...` could show a fake all-OK page on the real domain | Only localhost overrides, a visible banner, and a strict CSP listing the exact RPC hosts | browser check |
| The simulator ignored the chain check; the "in sync" line compared reported, not enforced, status | Both fixed | browser check |
| Federal Register URL only had to start with the API prefix; NCUA unwatched; FINRA filings and withdrawn exemptions treated as harmless; Base Sepolia clears not watched | All fixed | config, classifier and trigger tests |
| Four planted bugs survived only the generated-file check | Behavioral tests added; `planted-bugs.ts` runs without that check | `bun planted-bugs.ts` |

A later judge-style review found one more consensus edge: the effective-date query had no
upper bound on publication date, so a run during the day could see part of an issue that was
still posting. It is now capped at the window end, and the cap is enforced on the response
(`a pending rule published after the window end throws`).

## Review history of live documents

Every flagged document is checked by hand. That has changed the rules twice:
- **2026-10-18.** A CFTC proposal named "Regulation Crypto Asset Transactions" was tagged as
  tokenized securities. That rule now applies only to the SEC, with a regression test.
- **2026-10-20.** The Markets `REVIEW` came from an exchange's options-listing filing
  ([2026-21128](https://www.federalregister.gov/d/2026-21128)), and the AML `REVIEW` from
  FinCEN withdrawing a proposal ([2026-20430](https://www.federalregister.gov/d/2026-20430)),
  which removes an obligation rather than adding one. Both are now informational, and both
  documents are regression tests.

## Earlier deployment (v1)

Kept for the record, no longer written to.

| | Address / transaction |
|---|---|
| RegGateStatus v1, Sepolia | [`0x03d0df9e8ef2785b241eacca9460a60dd4daa075`](https://sepolia.etherscan.io/address/0x03d0df9e8ef2785b241eacca9460a60dd4daa075) |
| First broadcast, rejected (`FutureReport`, forwarder `result=false`) | [`0x7cc3…de65`](https://sepolia.etherscan.io/tx/0x7cc3b7864da41343b7e72fd9ecb58c4e20d02ac46925b4a5277e2c4aa4efde65) |
| Second broadcast, accepted (2026-10-19) | [`0x205d…bb0d`](https://sepolia.etherscan.io/tx/0x205ddf1792e113a3a3d8ffed037cf0c86e1ca3032f4da621346f564035adbb0d) |
| Effective-date gate, accepted (2026-10-20) | [`0x0c1c…74f6`](https://sepolia.etherscan.io/tx/0x0c1c93d22bd217949945cf6a2541d862e509df6fec4fb0998eca3b85b4d174f6) |
| First Base Sepolia broadcast, accepted (2026-10-20) | [`0x9cb2…dc98`](https://sepolia.basescan.org/tx/0x9cb2daea1a1ff3eae8ca1bd5009d693fce7209c93d74cdc049acaa1bcd23dc98) |

The first broadcast was rejected by the contract's future-timestamp guard, and that exposed a
workflow bug: the report carried the cron trigger's next slot (04:00 UTC) while the chain was
at 03:04 UTC. The workflow now stamps reports with DON time (`runtime.now()`), with a
regression test.

The first Base Sepolia broadcast showed both sides of the heartbeat in one run. Sepolia was
skipped: nothing had changed and the last report was 38 minutes old. Base Sepolia was written:
the contract was minutes old, so it did not exist yet at the last finalized block, and the
failed read counted as "changed".

## Verification

| Suite | Tests | Planted bugs caught |
|---|---|---|
| Workflow (`regGate.test.ts`, `e2e.test.ts`, `workflow.test.ts`) | 136 | 58 of 58 |
| Contracts (`RegGateStatus.t.sol`, `GatedToken.t.sol`) | 59 | 31 of 31 |

A planted bug breaks one line of production code (for example, removing the forwarder check
or ignoring the HTTP status) and confirms at least one test fails.
[`planted-bugs.ts`](reg-gate-workflow/planted-bugs.ts) applies each one, runs the suites, and
reverts it. Two contract checks guard states the contract cannot reach on its own; their tests
force those states with a storage write.

Checked by hand:
- **2026-10-18.** Agency slugs and document-type strings against the live Federal Register
  API. The full on-chain path on a local chain with Sepolia's chain ID.
- **2026-10-20.** The `effective_on` field and the type and effective-date filters against
  the live API. The SRO and withdrawal exclusions against the live documents that triggered
  them. The Base Sepolia chain ID, RPC, and simulation forwarder bytecode. The deploy scripts
  on local chains with Sepolia's and Base Sepolia's chain IDs, including the refusal to deploy
  production mode without an author. The status page against local chains in live, blocked,
  latched, stale, unreachable and hostile-override states, at desktop and 375px widths.
- The `LatchCleared` topic and the `snapshot()` ABI are checked against `deploy/artifacts`,
  and CI checks those artifacts against a fresh `forge build`.

All four v2 contracts are verified on Etherscan and Basescan from the standard JSON inputs in
[`contracts/verify/`](contracts/verify/).

## Deploy

All scripts run from the project root, so Bun loads `CRE_ETH_PRIVATE_KEY` from `.env`. The key
is never printed. The scripts refuse any chain other than Sepolia and Base Sepolia, and check
the RPC's chain ID before sending anything.

```bash
bun install --cwd deploy
bun deploy/address.ts                         # public address, Sepolia and Base Sepolia balances
bun deploy/bridge.ts --confirm                # optional: move 0.02 testnet ETH to Base Sepolia
bun deploy/deploy.ts                          # RegGateStatus + gUSD + gAST on Sepolia
bun deploy/deploy.ts --network base-sepolia   # the Base Sepolia contract
bun deploy/verify-inputs.ts                   # explorer verification inputs for what was deployed
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast
bun deploy/status.ts
```

The default forwarders are the CRE simulation forwarders (Sepolia
`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`, Base Sepolia
`0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`, from `cre workflow supported-chains`), and behind
them the contract deploys in simulation mode. Any other forwarder is production mode and needs
`--author <workflow owner>`.

## Layout

```
reg-gate-workflow/
  rules.ts              classifier, parser, query builders, explain() (pure, no imports)
  regGate.ts            heartbeat rule and report encoder (viem); re-exports rules.ts
  workflow.ts           CRE wiring: cron or LatchCleared -> fetch -> consensus -> per chain: read -> write
  main.ts               CRE entry point
  build-page.ts         builds docs/rules.js from rules.ts for the status page
  planted-bugs.ts       breaks one line at a time and confirms a test fails
  regGate.test.ts       classifier, explain and heartbeat tests
  e2e.test.ts           real handlers for both triggers, mocked HTTP and two chains
  workflow.test.ts      config, trigger wiring, ABI and page-build cross-checks
contracts/
  src/RegGateStatus.sol    receiver: review queue, coverage gap, replay guards, snapshot()
  src/GatedToken.sol       demo ERC-20 gated on a category
  test/                    Foundry tests
  verify/                  standard JSON inputs and constructor arguments for the explorers
deploy/
  deploy.ts, bridge.ts, verify-inputs.ts, status.ts, diagnose.ts, address.ts, lib.ts
docs/
  index.html, app.js, app.css, rules.js   live status page (GitHub Pages)
project.yaml        CRE RPC endpoints per target
```
