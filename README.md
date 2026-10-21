# <img src="docs/icon.svg" width="36" height="36" alt="" align="top"> Reg-Gate

[![CI](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml)

**Live on-chain regulatory status for tokenized assets.** A Chainlink CRE workflow reads
U.S. Federal Register publications, sorts them into four asset categories, and writes a
fail-closed status on-chain. Token contracts check it before every transfer.

- **Live status page:** https://nctrnlsoul.github.io/reg-gate/ (live statuses on both chains, a transfer simulator, and a "why this status" trail computed by the same classifier the DON runs)
- **Two chains:** the same agreed status on Ethereum Sepolia and Base Sepolia, each report bound to its own chain ID, all contracts verified on Etherscan and Basescan
- **Independently audited (2026-10-20):** four reviewers who had not seen the code. Every real finding is fixed and has a test ([what they found](#independent-audit-2026-10-20))
- **Verification:** 119 workflow tests, 51 contract tests, and 70 of 70 planted bugs caught, reproducible with `bun planted-bugs.ts`

> Reg-Gate flags regulatory publications for human review. It is not legal advice and
> does not interpret the law.

> **Demo security status.** The live contracts run behind Chainlink's CRE **simulation**
> forwarder, which checks no DON signatures, so anyone who calls that forwarder can write a
> report to them. That is inherent to testnet simulation, and the contracts say so on-chain
> (`simulation() == true`). A production deployment uses the real KeystoneForwarder and
> refuses every report until a workflow owner is pinned (see [Demo-safe vs deploy-safe](#demo-safe-vs-deploy-safe)).

## The problem

Tokenized assets move 24/7. Regulation does not announce itself to smart contracts. When the
SEC proposes a custody rule or Treasury finalizes stablecoin rules, a token has no way to know,
and an issuer finds out from the news. Reg-Gate turns the official record into an on-chain
signal a token can act on, and it is built to fail safe: when it does not know, it blocks.

## How it works

```
 Federal Register API          Chainlink DON (CRE)                     Ethereum Sepolia
 (no key, public)         ┌──────────────────────────────┐     ┌────────────────────────┐
         │                │ trigger: cron or LatchCleared│◄────┤ emits LatchCleared     │
         └─ 2 queries ───►│ every node fetches the same  │     │ RegGateStatus          │
                          │  finished window             │     │  forwarder-only writes │
                          │  classify (deterministic)    │     │  chain + replay guards │
                          │ identical consensus          │read │  every blocking doc    │
                          │ per chain: read latest and   │◄────┤  needs a human review  │
                          │  finalized state, skip if    ├────►│  stale => BLOCK        │
                          │  unchanged, else sign+write  │     └───────────┬────────────┘
                          └──────────────┬───────────────┘                 │ isAllowed()
                                         │ same result,      ┌─────────────▼────────────┐
                                         │ own chain ID      │ GatedToken transfers     │
                                         ▼                   └──────────────────────────┘
                          ┌──────────────────────────────┐
                          │ Base Sepolia: RegGateStatus  │  (LatchCleared here re-checks too)
                          └──────────────────────────────┘
```

1. **Fetch.** On a cron schedule (or when a reviewer clears a latch on either chain, see
   step 7), every node makes two queries to the public Federal Register API:
   - documents **published** in a 14-day window ending yesterday, so all nodes see the same
     finished days;
   - final rules whose **effective date** falls between the window start and a year ahead,
     whenever they were published. This catches rules taking effect now and rules with long
     notice periods.

   Both must succeed, or nothing is written.
2. **Classify.** A deterministic rules engine ([`reg-gate-workflow/rules.ts`](reg-gate-workflow/rules.ts))
   sorts documents into `STABLECOINS`, `TOKENIZED_SECURITIES`, `DIGITAL_ASSET_MARKETS`,
   `AML_SANCTIONS`. Only watched regulators count: SEC, CFTC, Treasury, OCC, FDIC, Fed,
   FinCEN, OFAC, CFPB, IRS, NCUA, and the Executive Office of the President.

   | Document | Status |
   |---|---|
   | Final Rule in effect (judged against the run's own date), or with no effective date | `BLOCK` |
   | Final Rule not yet in effect, up to a year ahead | `REVIEW` |
   | Presidential Document | `BLOCK` |
   | Proposed Rule, Notice | `REVIEW` |
   | An exchange's own rule filing that the SEC publishes for comment (SRO notice), except FINRA | informational |
   | An agency withdrawing its own proposal, unless it withdraws an exemption or relief | informational |
   | Anything else | `BLOCK` (unknown fails closed) |
   | More results than one page holds, on either query | every category `BLOCK` |

   A final rule blocks when it takes effect, not when it is published, so issuers get the
   notice period the agency gave them. Informational documents are counted in every run's
   log but never move a status. Neither kind puts a new obligation on an issuer. The type
   must match exactly. The title must match an anchored pattern: the SRO prefix at the start,
   "; Withdrawal" at the end. The SRO check also requires the SEC to be the only agency.
   A near miss takes the normal path.

3. **Agree.** Nodes must return byte-identical results. There is no LLM in the decision
   path on purpose: LLM output differs between runs and would break consensus.
4. **Every blocking document needs its own human review.** The report lists every document
   at `BLOCK`, not only the newest. While any listed document is unreviewed, the category
   is latched at `BLOCK`, even if later reports say `OK`. A reviewer clears one document at
   a time with `clearLatch(category, document)`, naming the exact document they read. Clearing
   one latches the next unreviewed one straight away. When every listed document has been
   reviewed, `BLOCK` reads as `REVIEW`, never `OK`.
5. **Read, then write only if it matters.** For each chain, the workflow reads the
   contract's `snapshot()` at both the latest and the last finalized block (an EVM read
   through CRE). It skips the write only if both already equal the new result and the last
   report is younger than the heartbeat (24 hours, never more than half of the contract's
   `maxAge`). Any doubt means write: a skipped write ages the chain toward stale, a redundant
   one only costs gas.
6. **Mirror.** The same agreed result goes to Base Sepolia, with its own contract, its own
   chain ID in the payload, and its own skip-or-write decision. Chains are independent: one
   failing does not stop the other, the run still fails loudly, and that chain's staleness
   rule turns continued silence into `BLOCK`.
7. **Enforce and re-verify.** [`GatedToken.sol`](contracts/src/GatedToken.sol) asks the gate
   before every transfer. Strict tokens pass only on `OK`; lenient tokens pass on anything
   but `BLOCK`. When a reviewer clears a latch on either chain, the contract emits
   `LatchCleared`, and an EVM log trigger runs the same check immediately. The handler
   refuses logs from any other contract, any other event, and logs removed by a reorg.

## Live result

First report from the audited v2 contracts, broadcast 2026-10-20 against the live Federal
Register: publications 2026-10-06 to 2026-10-19, effective dates judged as of 2026-10-20.
4 documents matched, 5 informational, 11 ignored, 0 blocking.

| Category | Status | Trigger |
|---|---|---|
| Stablecoins | REVIEW | [2026-20729](https://www.federalregister.gov/d/2026-20729) NCUA proposal to collect Call Report data on credit unions' payment stablecoin activities |
| Tokenized securities | REVIEW | [2026-20466](https://www.federalregister.gov/d/2026-20466) SEC proposed crypto custody rules ("tokenized private funds") |
| Digital asset markets | REVIEW | [2026-20888](https://www.federalregister.gov/d/2026-20888) CFTC "Regulation Crypto Asset Transactions and Markets" |
| AML and sanctions | OK | two FinCEN withdrawals in window, both informational |

The Stablecoins flag is new, and it is correct: NCUA, a GENIUS Act stablecoin regulator, was
added to the watched agencies by the audit, and its first in-window document is exactly the
kind of stablecoin groundwork an issuer wants to see. Under these statuses the demo token
`gUSD` (stablecoins, lenient) still transfers at REVIEW, and `gAST` (digital asset markets,
strict) is blocked.

Every flagged document is checked by hand. That review has changed the rules twice:
- **2026-10-18.** A CFTC proposal named "Regulation Crypto Asset Transactions" was tagged as
  tokenized securities. That rule now applies only to the SEC, with a regression test.
- **2026-10-20.** The Markets `REVIEW` came from an exchange's options-listing filing
  ([2026-21128](https://www.federalregister.gov/d/2026-21128)), and the AML `REVIEW` from
  FinCEN withdrawing a proposal ([2026-20430](https://www.federalregister.gov/d/2026-20430)),
  which removes an obligation rather than adding one. Both are now informational, and both
  documents are regression tests.

## Live on-chain

Audited v2 contracts, deployed 2026-10-20 in simulation mode.

| | Address / transaction |
|---|---|
| RegGateStatus, Ethereum Sepolia | [`0x7a69df6b68752e9e6377eb144dda7fbb594f7d9a`](https://sepolia.etherscan.io/address/0x7a69df6b68752e9e6377eb144dda7fbb594f7d9a) |
| gUSD (stablecoins, lenient) | [`0xc2bb916e02130f9461ad47a4011b5e31a189df7b`](https://sepolia.etherscan.io/address/0xc2bb916e02130f9461ad47a4011b5e31a189df7b) |
| gAST (digital asset markets, strict) | [`0xc3aedef662a6437a8f16a67c567bdbe56cf29cda`](https://sepolia.etherscan.io/address/0xc3aedef662a6437a8f16a67c567bdbe56cf29cda) |
| RegGateStatus, Base Sepolia mirror | [`0x328c1c98b499485eaa499b3e3747a971a849dad9`](https://sepolia.basescan.org/address/0x328c1c98b499485eaa499b3e3747a971a849dad9) |
| First report, Sepolia, **accepted** (forwarder `result=true`) | [`0xcd60…c4`](https://sepolia.etherscan.io/tx/0xcd60750d9a35c902056b6f6379cb1f3132cbfbae1b7ac0de25326e1e7ad4fac4) |
| First report, Base Sepolia, **accepted** (forwarder `result=true`) | [`0x858a…6c`](https://sepolia.basescan.org/tx/0x858a34bc54558eb2dd4554e1e713cdaaf000e7cc1190279dfe8db837ff50606c) |

Full records in [`deploy/deployments/`](deploy/deployments/). The Base Sepolia address happens
to equal the v1 gAST address on Sepolia: both were the deployer's transaction number 2 on
their chain, and a contract address depends only on the deployer and that number. They are
unrelated contracts on different chains.

All four v2 contracts are verified (source, ABI, Read Contract) on Etherscan and Basescan,
from the standard JSON inputs in [`contracts/verify/`](contracts/verify/). Check the live state
yourself with `bun deploy/status.ts` (read-only, no key, no gas).

**Previous deployment (v1, before the audit).** Kept for the record, no longer written to.

| | Address / transaction |
|---|---|
| RegGateStatus v1, Sepolia | [`0x03d0df9e8ef2785b241eacca9460a60dd4daa075`](https://sepolia.etherscan.io/address/0x03d0df9e8ef2785b241eacca9460a60dd4daa075) |
| First broadcast, **rejected** (`FutureReport`, forwarder `result=false`) | [`0x7cc3…de65`](https://sepolia.etherscan.io/tx/0x7cc3b7864da41343b7e72fd9ecb58c4e20d02ac46925b4a5277e2c4aa4efde65) |
| Second broadcast, **accepted** (2026-10-19) | [`0x205d…bb0d`](https://sepolia.etherscan.io/tx/0x205ddf1792e113a3a3d8ffed037cf0c86e1ca3032f4da621346f564035adbb0d) |
| Effective-date gate, **accepted** (2026-10-20) | [`0x0c1c…74f6`](https://sepolia.etherscan.io/tx/0x0c1c93d22bd217949945cf6a2541d862e509df6fec4fb0998eca3b85b4d174f6) |
| First mirror broadcast, Base Sepolia, **accepted** (2026-10-20) | [`0x9cb2…dc98`](https://sepolia.basescan.org/tx/0x9cb2daea1a1ff3eae8ca1bd5009d693fce7209c93d74cdc049acaa1bcd23dc98) |

That mirror broadcast showed both halves of the heartbeat on live chains, in one run.
Sepolia was skipped: every status was unchanged and the last report was 38 minutes old.
Base Sepolia was written: the contract was minutes old, so it did not exist yet at the last
finalized block, the read came back empty, and the workflow treated the failed read as
"changed".

## Why this status

The status page explains every category with `explain()` from
[`rules.ts`](reg-gate-workflow/rules.ts), built to `docs/rules.js`. It is the classifier the
DON runs, not a copy: the page fetches the trigger document, runs it through the same strict
parser and rules, and shows the agency check, the exact text that matched, the exclusions, the
severity, and what the contract enforces. A test holds `explain()` to `classify()` across
every fixture, and CI fails if `docs/rules.js` drifts from a fresh build. The page only
explains: every status it shows is read from the contract.

## Fail-closed design

| Situation | Result |
|---|---|
| API down, bad JSON, unexpected shape, node disagreement | Nothing written. Contract goes stale, then reads `BLOCK`. |
| Error status with a body that parses as "no results" | Rejected. Never reported as all-OK. |
| Document outside the requested window, on either query | Run aborts. The API response is not trusted. |
| No report ever received, or the last one older than `maxAge` | `BLOCK` |
| Matched document of unknown type | `BLOCK` |
| Final rule with no effective date | `BLOCK` (treated as already in effect) |
| More results than one page holds, on either query | Every category `BLOCK` |
| More than 16 blocking documents at once | Nothing written: a partial list could let one escape review |
| Blocking document not yet reviewed | `BLOCK`, through later `OK` reports, until a human clears that document |
| Second blocking document arrives while one is latched | Latched as soon as the first is cleared |
| Reviewer clears with the wrong document named | Rejected (`LatchedDocMismatch`) |
| All blocking documents reviewed, still in the window | `REVIEW`, never `OK` |
| Trigger log from another contract, another event, or reorged out | Refused. Nothing fetched, nothing written. |
| Out-of-order or replayed report | Rejected: strictly increasing timestamp, at most 2 minutes ahead of block time |
| A report replayed on the other chain | Rejected: every payload carries its own chain ID |
| Malformed report (trailing bytes, inconsistent lists) | Rejected (`InvalidReport`) |
| On-chain read fails, or latest and finalized disagree | Treated as changed: the report is written |
| Heartbeat set longer than the contract's `maxAge` allows | Capped at half of `maxAge` |
| One chain's write fails or throws | The other chain is still written; the run fails loudly; the failed chain goes stale, then `BLOCK` |
| Production contract with no workflow owner pinned | Cannot be deployed, and refuses every report |
| Status page cannot reach the chain, or the chain returns implausible values | Shows `UNKNOWN`, never `OK` |
| Status page link with a custom RPC (`?rpc=`) | Only localhost is honored, and the page then shows a "Test RPC, not live" banner |

**Write access.** Reports are accepted only from the Chainlink forwarder, from the pinned
workflow owner (production), for this chain, with a strictly increasing timestamp. That
covers the two replay risks Chainlink's consumer-contract docs warn about: cross-chain
replay and same-chain replay of a failed report. Ownership moves in two steps
(`transferOwnership`, then `acceptOwnership`), and the author pin cannot be set to zero.

## Known limits

Honest edges of the design, none hidden by the tests:
- **Title and abstract only.** The search matches full text, but the classifier reads the
  title and abstract. A rule that mentions digital assets only deep in its body is missed.
- **Keyword triage, not legal analysis.** It will have false positives and misses. It routes
  documents to a human; it does not interpret them.
- **Publication lookback is 14 days.** A proposal older than that no longer holds `REVIEW`.
  Final rules are covered separately by the effective-date query, a year ahead.
- **Heartbeat guarantee assumes the cron runs at least every `maxAge / 2`.** The demo runs
  every 6 hours against a 7-day `maxAge`.
- **Forwarder and gate are immutable.** Moving to a new forwarder means redeploying, and a
  token is bound to its gate for life. That is deliberate: no admin can redirect either.

## Independent audit (2026-10-20)

Four reviewers who had not seen the project audited the contracts, the workflow, the status
page, and the repo. They found no secrets in the git history, no script injection on the
page, and no em dashes. What they did find, and what changed:

| Finding | Fix | Test |
|---|---|---|
| A second blocking document could go unreviewed: only one document per category was tracked, so clearing one could hide another | Reports list every blocking document; the contract needs a human clear for each, naming it | `test_documentArrivingDuringLatchIsLatchedAfterClear`, `test_unreviewedDocumentBehindReviewedTriggerLatches` |
| A rule taking effect today read `REVIEW` (or `OK` if published before the window) for a day | Effective dates judged against the run's own date | `a rule taking effect today reads BLOCK today` |
| Notice periods longer than the lookback read `OK` until the rule took effect | Effective-date query reaches a year ahead | `a rule published long before the window and pending for months reads REVIEW` |
| A truncated result set floored at `REVIEW`, which lenient tokens pass | Floors at `BLOCK` | `truncated results floor every category at BLOCK` |
| The heartbeat read only the finalized block, so it could skip on stale data | Skips only if latest and finalized both match | `latest block holds a newer, different write` |
| The author pin was optional and could be unset | Production requires an author at deploy; the setter rejects zero; simulation mode is an explicit, immutable flag | `test_constructorRejectsZeroAddressesAndMissingAuthor`, `test_authorCannotBeUnpinned` |
| A far-future report could lock out on-time ones for 15 minutes | Skew cut to 2 minutes | `test_futureSkewBoundary` |
| Single-step ownership transfer; trailing report bytes accepted | Two-step ownership; exact report length | `test_twoStepOwnership`, `test_rejectsMalformedReports` |
| `?rpc=https://...` could show a fake all-OK page on the real domain | Only localhost overrides, a visible banner, and a strict CSP that lists the exact RPC hosts | browser check |
| The simulator ignored the chain check; the "in sync" line compared reported, not enforced, status | Both fixed | browser check |
| Federal Register URL only had to start with the API prefix; NCUA unwatched; FINRA filings and withdrawn exemptions treated as harmless; Base Sepolia clears not watched | All fixed | config, classifier and trigger tests |
| Four planted bugs survived only the generated-file check | Behavioral tests added; `planted-bugs.ts` now runs without that check | `bun planted-bugs.ts` |
| README overstated three guarantees | Rewritten above, with a Known limits section | |

## Layout

```
reg-gate-workflow/
  rules.ts              classifier, parser, query builder, explain() (pure, no imports)
  regGate.ts            heartbeat rule and report encoder (viem); re-exports rules.ts
  workflow.ts           CRE wiring: cron or LatchCleared -> fetch -> consensus -> per chain: read -> write
  main.ts               CRE entry point
  build-page.ts         builds docs/rules.js from rules.ts for the status page
  planted-bugs.ts       breaks one line at a time and confirms a test fails (workflow and contracts)
  regGate.test.ts       77 classifier, explain and heartbeat tests
  e2e.test.ts           27 end-to-end tests: real handlers for both triggers, mocked HTTP and two chains
  workflow.test.ts      15 config, trigger-wiring, ABI and page-build cross-checks
contracts/
  src/RegGateStatus.sol    on-chain receiver: per-document review, replay guards, snapshot()
  src/GatedToken.sol       demo ERC-20 gated on a category
  test/                    51 Foundry tests, including the audit's proof-of-concept scenarios
  verify/                  standard JSON inputs and constructor arguments for the explorers
deploy/
  deploy.ts         deploy to Sepolia (or the Base Sepolia mirror), update configs and the page
  bridge.ts         move testnet ETH from Sepolia to Base Sepolia through Base's official bridge
  verify-inputs.ts  regenerate contracts/verify/ from the source and the deployment records
  status.ts         read the live status and simulate a transfer on each token (no key, no gas)
  diagnose.ts       explain what a broadcast transaction did on-chain (no key, no gas)
  address.ts        print the burner's public address and balances
  lib.ts            shared chain guards and key handling
docs/
  index.html, app.js, app.css   live status page (GitHub Pages)
  rules.js          generated from rules.ts; CI fails if it differs from a fresh build
project.yaml        CRE RPC endpoints per target
```

## Run it

```bash
# workflow tests and typecheck (from reg-gate-workflow/)
bun install
bun run typecheck
bun run test
bun planted-bugs.ts            # needs forge on PATH for the contract half

# contract tests (from contracts/, needs Foundry)
forge test

# simulate against the live Federal Register (from the project root)
# trigger 0 = cron, 1 = LatchCleared on Sepolia, 2 = LatchCleared on Base Sepolia
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0
```

## Deploy

All scripts run from the project root, so Bun loads `CRE_ETH_PRIVATE_KEY` from `.env`. The
key is never printed. The scripts refuse any chain other than Sepolia and Base Sepolia, and
check the RPC's chain ID before sending anything.

```bash
bun install --cwd deploy
bun deploy/address.ts                         # public address, Sepolia and Base Sepolia balances
bun deploy/bridge.ts --confirm                # optional: move 0.02 testnet ETH to Base Sepolia
bun deploy/deploy.ts                          # RegGateStatus + gUSD + gAST on Sepolia
bun deploy/deploy.ts --network base-sepolia   # the Base Sepolia mirror
bun deploy/verify-inputs.ts                   # explorer verification inputs for what was deployed
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast
bun deploy/status.ts
```

The default forwarders are the CRE **simulation** forwarders (Sepolia
`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`, Base Sepolia
`0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`, from `cre workflow supported-chains`), and
behind them the contract deploys in simulation mode. Any other forwarder is production mode
and needs `--author <workflow owner>`.

## Demo-safe vs deploy-safe

**Demo-safe (this repo):** Sepolia and Base Sepolia testnets, a throwaway burner key, the
simulation forwarders (anyone can write through them), simulation mode, and a 7-day `maxAge`
so the status page stays readable between runs.

**Before any production use:**
1. Deploy with the production KeystoneForwarder and `--author <workflow owner>`, and a
   `maxAge` of about 2x the cron interval.
2. Use a dedicated deployer, and a separate reviewer, ideally a multisig.
3. Treat the keyword classifier as a triage signal for human review (see Known limits).

## Verification

| Suite | Tests | Planted bugs caught |
|---|---|---|
| Workflow (`regGate.test.ts`, `e2e.test.ts`, `workflow.test.ts`) | 119 | 45 of 45 |
| Contracts (`RegGateStatus.t.sol`, `GatedToken.t.sol`) | 51 | 25 of 25 |

"Planted bugs" means deliberately breaking one line of production code (for example,
removing the forwarder check or ignoring the HTTP status) and confirming at least one test
fails. The list is code, not a claim: [`reg-gate-workflow/planted-bugs.ts`](reg-gate-workflow/planted-bugs.ts)
applies each one, runs the suites, and reverts it. Two contract checks guard states the
contract cannot reach on its own; their tests force those states with a storage write to
prove the second line of defense holds.

Also verified by hand:
- **2026-10-18.** Agency slugs and document-type strings against the live Federal Register
  API. The full on-chain path on a local Sepolia-ID chain. The first real Sepolia broadcast
  was **rejected by the contract**, exactly as designed: the report carried the cron
  trigger's next slot, 04:00 UTC (midnight in the simulator's local time zone, US Eastern),
  while the chain was at 03:04 UTC, so `RegGateStatus` refused it with `FutureReport`. The
  workflow now stamps reports with DON consensus time (`runtime.now()`), with a regression test.
- **2026-10-20.** The `effective_on` field and the type and effective-date filters against
  the live API. The SRO and withdrawal exclusions against the live documents that triggered
  them. The Base Sepolia chain ID, RPC, and mock forwarder bytecode. The deploy scripts on
  local chains with Sepolia's and Base Sepolia's chain IDs, including the refusal to deploy
  production mode without an author. The status page against local chains in live, blocked,
  latched, stale, unreachable and hostile-override states, at desktop and 375px widths, with
  no console errors and no horizontal overflow.
- The LatchCleared topic and the `snapshot()` read are checked against `deploy/artifacts`,
  and CI checks those artifacts against a fresh `forge build`, so a contract change cannot
  leave the workflow reading or listening for something that no longer exists.

## License

MIT. Built by NorthSchema.
