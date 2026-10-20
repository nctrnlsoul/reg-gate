# <img src="docs/icon.svg" width="36" height="36" alt="" align="top"> Reg-Gate

[![CI](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml)

**Live on-chain regulatory status for tokenized assets.** A Chainlink CRE workflow reads
U.S. Federal Register publications, sorts them into four asset categories, and writes a
fail-closed status on-chain. Token contracts check it before every transfer.

- **Live status page:** https://nctrnlsoul.github.io/reg-gate/
- **Contract on Sepolia:** [`0x03d0…a075`](https://sepolia.etherscan.io/address/0x03d0df9e8ef2785b241eacca9460a60dd4daa075) (full record in [`deploy/deployments/sepolia.json`](deploy/deployments/sepolia.json))
- **Contracts verified on Etherscan:** RegGateStatus, gUSD and gAST (source, ABI, Read Contract)
- **Two chains:** the same agreed status on Ethereum Sepolia and Base Sepolia, each report bound to its own chain
- **Verification:** 96 workflow tests, 33 contract tests, every planted bug caught (details below)

> Reg-Gate flags regulatory publications for human review. It is not legal advice and
> does not interpret the law.

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
         └─ 2 queries ───►│ every node fetches a fixed   │     │ RegGateStatus          │
                          │  finished window             │     │  forwarder-only writes │
                          │  classify (deterministic)    │     │  chain + replay guards │
                          │ identical consensus          │read │  latch BLOCK           │
                          │ per chain: read finalized    │◄────┤  stale => BLOCK        │
                          │  state, skip if unchanged    ├────►│                        │
                          │  else sign + write           │     └───────────┬────────────┘
                          └──────────────┬───────────────┘                 │ isAllowed()
                                         │ same result,      ┌─────────────▼────────────┐
                                         │ own chain ID      │ GatedToken transfers     │
                                         ▼                   └──────────────────────────┘
                          ┌──────────────────────────────┐
                          │ Base Sepolia: RegGateStatus  │
                          └──────────────────────────────┘
```

1. **Fetch.** On a cron schedule (or when a reviewer clears a latch, see step 7), every node
   makes two queries to the public Federal Register API over a fixed lookback window ending
   the day before the run, so all nodes see the same finished days: documents published in
   the window, and final rules taking effect in the window, whenever they were published.
   Both must succeed or nothing is written.
2. **Classify.** A deterministic rules engine ([`reg-gate-workflow/regGate.ts`](reg-gate-workflow/regGate.ts))
   sorts documents into `STABLECOINS`, `TOKENIZED_SECURITIES`, `DIGITAL_ASSET_MARKETS`,
   `AML_SANCTIONS`. Only watched regulators count: SEC, CFTC, Treasury, OCC, FDIC, Fed,
   FinCEN, OFAC, CFPB, IRS, and the Executive Office of the President.

   | Document | Status |
   |---|---|
   | Final Rule in effect, or with no effective date | `BLOCK` |
   | Final Rule not yet in effect | `REVIEW` until its effective date, then `BLOCK` |
   | Presidential Document | `BLOCK` |
   | Proposed Rule, Notice | `REVIEW` |
   | An exchange's own rule filing that the SEC publishes for comment (SRO notice) | informational |
   | An agency withdrawing its own proposal | informational |
   | Anything else | `BLOCK` (unknown fails closed) |

   A final rule blocks when it takes effect, not when it is published, so issuers get the
   notice period the agency gave them. Informational documents are counted in every run's
   log but never move a status: neither puts a new obligation on an issuer. Both checks match
   type and title exactly (the SRO check also requires the SEC to be the only agency), so a
   near miss takes the normal path.

3. **Agree.** Nodes must return byte-identical results. There is no LLM in the decision
   path on purpose: LLM output differs between runs and would break consensus.
4. **Read, then write only if it matters.** For each chain, the workflow first reads what
   [`RegGateStatus.sol`](contracts/src/RegGateStatus.sol) already holds, at the last
   finalized block (an EVM read through CRE). If every status and trigger document is the
   same and the last report is younger than the heartbeat (24 hours, never more than half the
   contract's `maxAge`), it skips the write. Otherwise it signs a report bound to that
   chain's ID and writes it. Any doubt (a failed read, an odd shape, no report yet) means
   write: a skipped write ages the chain toward stale, a redundant one only costs gas.
5. **Mirror.** The same agreed result goes to Base Sepolia too, with its own contract,
   its own chain ID in the payload, and its own skip-or-write decision. Chains are
   independent: one failing does not stop the other, the run still fails loudly, and that
   chain's staleness rule turns continued silence into `BLOCK`.
6. **Enforce.** [`GatedToken.sol`](contracts/src/GatedToken.sol) asks the gate before every
   transfer. Strict tokens pass only on `OK`; lenient tokens pass on anything but `BLOCK`.
7. **Re-verify on override.** When a human reviewer clears a latched `BLOCK`, the contract
   emits `LatchCleared`. A second CRE trigger (an EVM log trigger on that event) runs the
   same check immediately. The clear was judged against a report up to one cron interval
   old, so if a newer blocking rule has landed since, it re-latches in minutes instead of
   leaving transfers open until the next scheduled run. The handler refuses logs from any
   other contract, any other event, and logs removed by a reorg.

## Live result (2026-10-20)

Broadcast against the live Federal Register, window 2026-10-06 to 2026-10-19: 3 documents
matched, 5 informational, 8 ignored.

| Category | Status | Trigger |
|---|---|---|
| Stablecoins | OK | none in window |
| Tokenized securities | REVIEW | [2026-20466](https://www.federalregister.gov/d/2026-20466) SEC proposed crypto custody rules ("tokenized private funds") |
| Digital asset markets | REVIEW | [2026-20888](https://www.federalregister.gov/d/2026-20888) CFTC "Regulation Crypto Asset Transactions and Markets" |
| AML and sanctions | OK | two FinCEN withdrawals in window, both informational |

With those statuses, the demo token `gUSD` (stablecoins, lenient) transfers freely and
`gAST` (digital asset markets, strict) is blocked at REVIEW.

Every flagged document is checked by hand. That review has changed the rules twice:
- **2026-10-18.** A CFTC proposal named "Regulation Crypto Asset Transactions" was tagged as
  tokenized securities. That rule now applies only to the SEC, with a regression test.
- **2026-10-20.** The Markets `REVIEW` came from an exchange's options-listing filing
  ([2026-21128](https://www.federalregister.gov/d/2026-21128)), and the AML `REVIEW` from
  FinCEN withdrawing a proposal ([2026-20430](https://www.federalregister.gov/d/2026-20430)),
  which removes an obligation rather than adding one. Both are now informational, and both
  documents are regression tests.

## Live on-chain

| | Address / transaction |
|---|---|
| RegGateStatus | [`0x03d0df9e8ef2785b241eacca9460a60dd4daa075`](https://sepolia.etherscan.io/address/0x03d0df9e8ef2785b241eacca9460a60dd4daa075) |
| gUSD (stablecoins, lenient) | [`0x1495a7c7b7be43c0503a1dfd3a4d63d027d3b2de`](https://sepolia.etherscan.io/address/0x1495a7c7b7be43c0503a1dfd3a4d63d027d3b2de) |
| gAST (digital asset markets, strict) | [`0x328c1c98b499485eaa499b3e3747a971a849dad9`](https://sepolia.etherscan.io/address/0x328c1c98b499485eaa499b3e3747a971a849dad9) |
| First broadcast, **rejected** (`FutureReport`, forwarder `result=false`) | [`0x7cc3…de65`](https://sepolia.etherscan.io/tx/0x7cc3b7864da41343b7e72fd9ecb58c4e20d02ac46925b4a5277e2c4aa4efde65) |
| Second broadcast, **accepted** (2026-10-19) | [`0x205d…bb0d`](https://sepolia.etherscan.io/tx/0x205ddf1792e113a3a3d8ffed037cf0c86e1ca3032f4da621346f564035adbb0d) |
| Effective-date gate, **accepted** (2026-10-20) | [`0x0c1c…74f6`](https://sepolia.etherscan.io/tx/0x0c1c93d22bd217949945cf6a2541d862e509df6fec4fb0998eca3b85b4d174f6) |

All three contracts are verified on Etherscan. Check the live state yourself with
`bun deploy/status.ts` (read-only, no key, no gas).

## Fail-closed design

| Situation | Result |
|---|---|
| API down, bad JSON, unexpected shape, node disagreement | Nothing written. Contract goes stale, then reads `BLOCK`. |
| Error status with a body that parses as "no results" | Rejected. Never reported as all-OK. |
| Document outside the requested window | Run aborts. The API response is not trusted. |
| No report ever received | `BLOCK` |
| Last report older than `maxAge` | `BLOCK` |
| Matched document of unknown type | `BLOCK` |
| Final rule with no effective date | `BLOCK` (treated as already in effect) |
| Effective-date query fails, or returns a non-rule or a date outside the window | Nothing written |
| More results than one page holds, on either query | Every category floored at `REVIEW` |
| `BLOCK` reported | Latches through later `OK` reports until the reviewer clears it |
| Reviewer cleared, same document still in window | `REVIEW`, never `OK` |
| New blocking document after a clear | Latches again, right away: the clear itself triggers a re-check |
| Trigger log from another contract, another event, or reorged out | Refused. Nothing fetched, nothing written. |
| Cron and LatchCleared runs land at nearly the same time | Each report must carry a newer timestamp than the last one stored, so an out-of-order report is rejected. Safe either way; at worst one wasted transaction. |
| On-chain read fails before a write | Treated as changed: the report is written |
| Heartbeat set longer than the contract's `maxAge` allows | Capped at half of `maxAge`, so two skipped runs can never leave a chain stale |
| One chain's write fails or throws | The other chain is still written; the run fails loudly; the failed chain goes stale, then `BLOCK` |
| A report replayed on the other chain | Rejected: every payload carries its own chain ID |
| Status page cannot reach the chain | Shows `UNKNOWN`, never `OK` |

**Write access.** Reports are accepted only from the Chainlink forwarder, from the pinned
workflow owner (once set), for this chain, with a strictly increasing timestamp. That
covers the two replay risks Chainlink's consumer-contract docs warn about: cross-chain
replay and same-chain replay of a failed report.

## Layout

```
reg-gate-workflow/
  regGate.ts            classifier, parser, query builder, heartbeat rule, report encoder (pure)
  workflow.ts           CRE wiring: cron or LatchCleared -> fetch -> consensus -> per chain: read -> write
  regGate.test.ts       59 classifier and heartbeat tests
  workflow.test.ts      13 config, trigger-wiring and ABI cross-check tests
  e2e.test.ts           24 end-to-end tests: real handlers for both triggers, mocked HTTP and two chains
contracts/
  src/RegGateStatus.sol    on-chain receiver
  src/GatedToken.sol       demo ERC-20 gated on a category
  test/                    33 Foundry tests
deploy/
  deploy.ts       deploy to Sepolia (or the Base Sepolia mirror), update configs and the status page
  status.ts       read the live status and simulate a transfer on each token (no key, no gas)
  address.ts      print the burner's public address for a faucet
docs/
  index.html      live status page (GitHub Pages): statuses, the Federal Register documents
                  behind them, why each token is open or blocked, and the on-chain event log
```

## Run it

```bash
# workflow tests and typecheck (from reg-gate-workflow/)
bun install
bun run typecheck
bun run test

# contract tests (from contracts/, needs Foundry)
forge test

# simulate against the live Federal Register (from the project root)
# trigger 0 = cron, trigger 1 = LatchCleared
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0

# replay a real LatchCleared event (needs a clearLatch transaction on Sepolia)
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive \
  --trigger-index 1 --evm-tx-hash <clearLatch tx hash> --evm-event-index 0
```

## Deploy

All scripts run from the project root, so Bun loads `CRE_ETH_PRIVATE_KEY` from `.env`. The
key is never printed. The scripts refuse any chain other than Sepolia and Base Sepolia, and check the RPC's chain ID before sending anything.

```bash
bun install --cwd deploy
bun deploy/address.ts          # public address to fund, with Sepolia and Base Sepolia balances
bun deploy/deploy.ts           # deploys RegGateStatus + gUSD + gAST, updates configs
bun deploy/deploy.ts --network base-sepolia   # deploys the Base Sepolia mirror, adds it to configs
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast
bun deploy/status.ts           # on-chain status + which tokens can transfer
```

The default forwarders are the **simulation** forwarders: Sepolia
`0x15fC6ae953E024d975e77382eEeC56A9101f9F88` and Base Sepolia
`0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` (both from `cre workflow supported-chains`).
Confirm it for your org with `cre workflow supported-chains`. The forwarder is immutable
by design, so moving to the production forwarder means redeploying.

## Demo-safe vs deploy-safe

**Demo-safe (this repo):** Sepolia and Base Sepolia testnets, a throwaway burner key, the simulation forwarders,
and a 7-day `maxAge` so the status page stays readable between runs.

**Before any production use:**
1. Redeploy with the production KeystoneForwarder and a `maxAge` of about 2x the cron interval.
2. Call `setExpectedAuthor(<workflow owner>)`. It is left unset for simulation only, because
   the simulation forwarder supplies no workflow metadata.
3. Use a dedicated deployer and a separate reviewer, ideally a multisig.
4. Treat the keyword classifier as a triage signal for human review. It will have false
   positives and misses.

## Verification

| Suite | Tests | Planted bugs caught |
|---|---|---|
| Classifier and heartbeat rule (`regGate.test.ts`) | 59 | 31 of 31 |
| Workflow end to end (`e2e.test.ts`) | 24 | 13 of 13 |
| Config, trigger wiring, ABI cross-checks (`workflow.test.ts`) | 13 | 2 of 2 |
| LatchCleared trigger (handler + wiring) | in the two rows above | 8 of 8 |
| RegGateStatus | 24 | 12 of 12 |
| GatedToken | 9 | 7 of 7 |

"Planted bugs" means deliberately breaking one line of production code (for example,
removing the forwarder check or ignoring the HTTP status) and confirming at least one test
fails. Several planted bugs initially survived and each exposed a weak or missing test,
which was then fixed. One was a real fail-open: an error response whose body parsed as
"zero results" would have reported all-OK.

Also verified by hand on 2026-10-18:
- Agency slugs and document-type strings against the live Federal Register API.
- The full on-chain path on a local Sepolia-ID chain: deploy, forwarder delivers the live
  report, a non-forwarder is rejected, `gUSD` transfers and `gAST` is blocked.
- The first real Sepolia broadcast was **rejected by the contract**, exactly as designed:
  the report carried the cron trigger's next scheduled slot (04:00 UTC) while the chain was
  at 03:04 UTC, so `RegGateStatus` refused it with `FutureReport` and the forwarder logged
  `result=false`. The workflow now stamps reports with DON consensus time
  (`runtime.now()`), with a regression test that recreates the failure.
- The LatchCleared trigger on a local Sepolia-ID chain: a real `BLOCK` report latches, the
  reviewer clears it, the real `clearLatch` receipt log runs the handler, and the report it
  produces (with a newer final rule in the mocked Federal Register response) re-latches the
  category on delivery. The trigger topic is also checked in CI against the compiled
  contract ABI, so renaming the event cannot leave the trigger listening for nothing.
- The status page in a headless browser across live, latched, stale, unreachable and
  not-deployed states, desktop and mobile, light and dark.

Also verified by hand on 2026-10-20:
- The `effective_on` field and the `conditions[type][]=RULE` and `conditions[effective_date]`
  filters against the live Federal Register API.
- The SRO and withdrawal exclusions against the live documents that triggered them
  (2026-21128, 2026-20430, 2026-20429).
- The Base Sepolia chain ID, RPC, and that the mock forwarder has bytecode on chain.
- The Base Sepolia deploy path on a local chain with Base Sepolia's chain ID: deploys, adds
  the mirror to both configs, keeps the Sepolia record intact, and refuses an RPC that
  reports the wrong chain.

## License

MIT. Built by NorthSchema.
