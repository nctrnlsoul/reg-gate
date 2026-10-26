# <img src="docs/icon.svg" width="36" height="36" alt="" align="top"> Reg-Gate

[![CI](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml)

**A compliance circuit breaker for tokenized assets.** A Chainlink CRE workflow searches the
U.S. Federal Register for digital asset terms, sorts what it finds into four asset categories,
and writes a fail-closed status on-chain. Tokens check it before every transfer, and every blocking
document needs a named human review, recorded on-chain.

- **Live status page:** https://nctrnlsoul.github.io/reg-gate/ (statuses read from the contract on both chains, a transfer simulator, and a "why this status" trail)
- **Deck (PDF):** https://nctrnlsoul.github.io/reg-gate/Reg-Gate-Deck.pdf
- **Two chains:** Ethereum Sepolia and Base Sepolia, each report bound to its own chain ID, all contracts verified on Etherscan and Basescan
- **Tests:** 136 workflow tests, 59 contract tests, and 89 of 89 planted bugs caught (`bun planted-bugs.ts`)

> **How it runs today.** The workflow runs in the CRE simulator (`cre workflow simulate --broadcast`):
> one node runs the compiled workflow and the same capabilities a DON would, and writes real
> transactions through Chainlink's **simulation forwarder**. That forwarder checks no DON
> signatures, so anyone can write through it; the contracts say so on-chain (`simulation() == true`).
> Deploying to a live DON needs CRE deployment access, which is granted on request. The production
> path is in [Demo-safe vs deploy-safe](#demo-safe-vs-deploy-safe). Reg-Gate flags documents for
> human review. It is not legal advice.

## Who uses this

An issuer of a tokenized fund, a stablecoin, or a tokenized security has to react when a
regulator acts in its asset class. Today it finds out from the news, and its token keeps moving.

Reg-Gate gives that issuer two things:
1. **A circuit breaker.** A token picks one category and a mode. **Lenient** tokens stop only
   on `BLOCK`: a final rule in effect or a presidential action. **Strict** tokens also pause
   on `REVIEW` (a proposal or a pending rule). That suits an issuer that wants to pause during
   any open rulemaking, such as during an offering. Most tokens would be lenient.
2. **An on-chain review record.** Every blocking document a report names joins a review queue
   on-chain, and the category stays `BLOCK` until a named reviewer clears each one, by
   document number, in order. A document stays queued even after it leaves the search window.
   Each clear is a timestamped event: who reviewed which federal document, and when.

When Reg-Gate does not know, it blocks. An outage or a bad response writes nothing, and once
the last report is older than `maxAge` (7 days) every category reads `BLOCK`.

## How it works

```
 Federal Register API           CRE workflow                            Ethereum Sepolia
 (no key, public)         ┌──────────────────────────────┐     ┌────────────────────────┐
         │                │ trigger: cron or LatchCleared│◄────┤ emits LatchCleared     │
         └─ 2 queries ───►│ fetch a finished date window │     │ RegGateStatus          │
                          │ classify (deterministic)     │     │  forwarder-only writes │
                          │ identical consensus          │read │  chain + replay guards │
                          │ per chain: read latest and   │◄────┤  every blocking doc    │
                          │  finalized state, skip if    ├────►│  needs a human review  │
                          │  unchanged, else report+write│     │  stale => BLOCK        │
                          └──────────────┬───────────────┘     └───────────┬────────────┘
                                         │ same result,                    │ isAllowed()
                                         ▼ own chain ID      ┌─────────────▼────────────┐
                          ┌──────────────────────────────┐   │ GatedToken transfers     │
                          │ Base Sepolia: RegGateStatus  │   └──────────────────────────┘
                          └──────────────────────────────┘
```

1. **Fetch.** Two queries: documents published in the last 14 finished days, and final rules
   taking effect from the window start to a year ahead. Both stop at yesterday, so every node
   sees the same documents. Both must succeed, or nothing is written.
2. **Classify.** [`rules.ts`](reg-gate-workflow/rules.ts) is a pure, deterministic classifier.
   Only watched regulators count: SEC, CFTC, Treasury, OCC, FDIC, Fed, FinCEN, OFAC, CFPB,
   IRS, NCUA, and the Executive Office of the President. A final rule in effect or a
   presidential document is `BLOCK`. A proposal, a notice, or a rule not yet in effect is
   `REVIEW`. An unknown type is `BLOCK`. There is no LLM in the path: its output would differ
   between nodes and break consensus.
3. **Agree.** Nodes must return byte-identical results, or the run writes nothing. (The
   simulator runs one node in place of the network.)
4. **Read, then write only if it matters.** For each chain, the workflow reads `snapshot()`
   at the latest and the last finalized block. It skips the write only if both already match
   and the last report is under 24 hours old. Any doubt means write.
5. **Enforce.** [`GatedToken.sol`](contracts/src/GatedToken.sol) asks the gate before every
   transfer and reverts with `TransferBlockedByRegGate`.
6. **Review and re-verify.** A reviewer calls `clearLatch(category, document)` for the
   document at the front of that category's queue. The contract emits `LatchCleared`, and an
   EVM log trigger re-runs the check at once on either chain.

## Chainlink CRE in this project

| Capability | Where | What it does |
|---|---|---|
| Cron trigger | [`workflow.ts#L358`](reg-gate-workflow/workflow.ts#L358) | Every 6 hours once deployed; started by hand in this demo |
| EVM log trigger | [`workflow.ts#L361`](reg-gate-workflow/workflow.ts#L361) | `LatchCleared` on either chain, at the safe head. The handler refuses other contracts, other events, and reorged logs ([`L334`](reg-gate-workflow/workflow.ts#L334)) |
| HTTP client + identical consensus | [`workflow.ts#L294`](reg-gate-workflow/workflow.ts#L294) | Both Federal Register queries; nodes must agree byte for byte |
| DON time | [`workflow.ts#L286`](reg-gate-workflow/workflow.ts#L286) | `runtime.now()` stamps the report, never a node clock |
| EVM read | [`workflow.ts#L186`](reg-gate-workflow/workflow.ts#L186) | `snapshot()` at latest and finalized, to skip unchanged writes ([`decideWrite`](reg-gate-workflow/workflow.ts#L218)) |
| Report + EVM write | [`workflow.ts#L257`](reg-gate-workflow/workflow.ts#L257) | Signed report, written per chain, chain ID in the payload. A report the contract rejects counts as a failed delivery ([`L265`](reg-gate-workflow/workflow.ts#L265)) |
| Receiver | [`RegGateStatus.sol#L137`](contracts/src/RegGateStatus.sol#L137) | `onReport`: forwarder only, chain ID, strictly increasing timestamp, and the pinned workflow owner in production mode |
| SDK test mocks | [`e2e.test.ts`](reg-gate-workflow/e2e.test.ts) | Real handlers for both triggers against `@chainlink/cre-sdk/test` HTTP and EVM mocks |

## Proof it runs

The v2 broadcast, 2026-10-20, trimmed (time stamps are the simulator's local time):

```
$ cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast
✓ Workflow compiled
[SIMULATION] Running trigger trigger=cron-trigger@1.0.0
[USER LOG] Reg-Gate: querying Federal Register 2026-10-06..2026-10-19 (published, taking effect)
[USER LOG] Reg-Gate: window 2026-10-06..2026-10-19 asOf=2026-10-20 blocking=0 matched=4 ignored=11 informational=5 truncated=false
           | STABLECOINS=REVIEW (2026-20729) TOKENIZED_SECURITIES=REVIEW (2026-20466) DIGITAL_ASSET_MARKETS=REVIEW (2026-20888) AML_SANCTIONS=OK
[USER LOG] Reg-Gate: ethereum-testnet-sepolia: no report on-chain yet (latest block); report written, txHash 0xcd60750d…fac4
[USER LOG] Reg-Gate: ethereum-testnet-sepolia-base-1: no report on-chain yet (latest block); report written, txHash 0x858a34bc…606c
```

| | Address / transaction |
|---|---|
| RegGateStatus, Ethereum Sepolia | [`0x7a69df6b68752e9e6377eb144dda7fbb594f7d9a`](https://sepolia.etherscan.io/address/0x7a69df6b68752e9e6377eb144dda7fbb594f7d9a) |
| gUSD (stablecoins, lenient) | [`0xc2bb916e02130f9461ad47a4011b5e31a189df7b`](https://sepolia.etherscan.io/address/0xc2bb916e02130f9461ad47a4011b5e31a189df7b) |
| gAST (digital asset markets, strict) | [`0xc3aedef662a6437a8f16a67c567bdbe56cf29cda`](https://sepolia.etherscan.io/address/0xc3aedef662a6437a8f16a67c567bdbe56cf29cda) |
| RegGateStatus, Base Sepolia | [`0x328c1c98b499485eaa499b3e3747a971a849dad9`](https://sepolia.basescan.org/address/0x328c1c98b499485eaa499b3e3747a971a849dad9) |
| Report on Sepolia, accepted (forwarder `result=true`) | [`0xcd60…c4`](https://sepolia.etherscan.io/tx/0xcd60750d9a35c902056b6f6379cb1f3132cbfbae1b7ac0de25326e1e7ad4fac4) |
| Report on Base Sepolia, accepted (forwarder `result=true`) | [`0x858a…6c`](https://sepolia.basescan.org/tx/0x858a34bc54558eb2dd4554e1e713cdaaf000e7cc1190279dfe8db837ff50606c) |

That report set these statuses:

| Category | Status | Trigger document |
|---|---|---|
| Stablecoins | REVIEW | [2026-20729](https://www.federalregister.gov/d/2026-20729) NCUA notice of proposed Call Report changes covering credit unions' payment stablecoin activities |
| Tokenized securities | REVIEW | [2026-20466](https://www.federalregister.gov/d/2026-20466) SEC proposed crypto custody rules |
| Digital asset markets | REVIEW | [2026-20888](https://www.federalregister.gov/d/2026-20888) CFTC advance notice of proposed rulemaking, "Regulation Crypto Asset Transactions and Markets" |
| AML and sanctions | OK | two FinCEN withdrawals in the window, informational |

So lenient `gUSD` can transfer and strict `gAST` is blocked. The status page always shows the
contract's current state. Check it yourself with `bun deploy/status.ts` (read-only, no key).

## Fail-closed design

| Situation | Result |
|---|---|
| API down, bad response, node disagreement | Nothing written. After `maxAge` (7 days) the contract reads `BLOCK` |
| No report, or the last one older than `maxAge` (7 days) | `BLOCK` |
| Unknown document type, or a final rule with no effective date | `BLOCK` |
| More results than one page holds, or a faulty response | Every category `BLOCK`, plus a dated `INCOMPLETE` entry a reviewer must clear |
| More blocking documents than one report holds (16) | Those categories `BLOCK`, plus an `INCOMPLETE` entry; the newest documents are listed |
| Reports stop for more than 14 days, then resume | Every category held until a reviewer clears a `COVERAGE-GAP` entry |
| Blocking document not yet reviewed | `BLOCK`, through later `OK` reports and after it leaves the window, until a reviewer clears that exact document |
| More than 64 documents waiting in one category | The report is rejected; the contract keeps reading `BLOCK` |
| The contract rejects a report | The workflow logs a failed delivery, not a success |
| Every blocking document reviewed, still in the window | `REVIEW`, never `OK` |
| Replayed, out-of-order, or other-chain report | Rejected by the contract |
| On-chain read fails, or latest and finalized disagree | Treated as changed: the report is written |
| Status page cannot reach the chain | Shows `UNKNOWN`, never `OK` |

Every case is in [ENGINEERING.md](ENGINEERING.md#fail-closed-cases).

## Known limits

- **Title, abstract, and search excerpts.** For body text the classifier sees only the short
  excerpts the Federal Register returns around each search match, not the full document.
- **Keyword triage, not legal analysis.** Expect false positives and misses. It routes documents to a human.
- **Publication lookback is 14 days.** Final rules are covered separately, a year ahead.
- **Run by hand in this demo.** The configured cron is every 6 hours. Until the workflow is
  deployed to a DON, it runs when someone runs the simulator, and `maxAge` (7 days) turns any
  gap past that into `BLOCK`.
- **Forwarder and gate are immutable.** Changing either means a redeploy. No admin can redirect them.
- **The owner has instant powers.** The owner can change the pinned workflow owner and the
  reviewer at once, with no timelock. Production should put both behind a multisig.
- **Workflow owner, not workflow ID.** In production mode the contract checks who owns the
  workflow, not which workflow it is. Any workflow from the same owner could write.
- **Simulation mode is open.** In this demo the simulation forwarder checks no signatures, so
  anyone can send a report through it. The contract says so on-chain (`simulation() == true`).

## Run it

```bash
# from reg-gate-workflow/
bun install && bun run typecheck && bun run test
bun planted-bugs.ts            # contract half needs forge on PATH

# from contracts/
forge test

# from the project root: trigger 0 = cron, 1 = LatchCleared on Sepolia, 2 = on Base Sepolia
cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0
```

Deploy scripts (`deploy/`) read the key from `.env`, never print it, and refuse any chain but
Sepolia and Base Sepolia. Commands are in [ENGINEERING.md](ENGINEERING.md#deploy).

## Demo-safe vs deploy-safe

**Demo-safe (this repo):** testnets only, a throwaway burner key, Chainlink's simulation
forwarders (anyone can write through them), and a 7-day `maxAge`.

**Before any production use:**
1. Deploy with the production KeystoneForwarder and `--author <workflow owner>`. A production
   contract cannot be deployed without one, and refuses every report until one is pinned.
2. Set `maxAge` to about 2x the cron interval, and deploy the workflow with `cre workflow deploy`.
3. Use a dedicated deployer and a separate reviewer, ideally a multisig.

## More detail

[ENGINEERING.md](ENGINEERING.md) has the full classification rules, every fail-closed case,
the pre-v2 security review and its fixes, the review history of live documents, the v1
deployment, and the manual verification log.

## License

MIT.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/northschema-mark-white.png"><img src="docs/northschema-mark-black.png" width="18" height="18" alt="" align="top"></picture> Built by NorthSchema.
