# Reg-Gate

[![CI](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/nctrnlsoul/reg-gate/actions/workflows/ci.yml)

**Live on-chain regulatory status for tokenized assets.** A Chainlink CRE workflow reads
U.S. Federal Register publications, sorts them into four asset categories, and writes a
fail-closed status on-chain. Token contracts check it before every transfer.

- **Live status page:** https://nctrnlsoul.github.io/reg-gate/
- **Contract on Sepolia:** see [`deploy/deployments/sepolia.json`](deploy/deployments/sepolia.json)
- **Verification:** 51 workflow tests, 33 contract tests, every planted bug caught (details below)

> Reg-Gate flags regulatory publications for human review. It is not legal advice and
> does not interpret the law.

## The problem

Tokenized assets move 24/7. Regulation does not announce itself to smart contracts. When the
SEC proposes a custody rule or Treasury finalizes stablecoin rules, a token has no way to know,
and an issuer finds out from the news. Reg-Gate turns the official record into an on-chain
signal a token can act on, and it is built to fail safe: when it does not know, it blocks.

## How it works

```
 Federal Register API          Chainlink DON (CRE)                     Sepolia
 (no key, public)         ┌──────────────────────────────┐     ┌────────────────────────┐
         │                │ every node:                  │     │ RegGateStatus          │
         └──── fetch ────►│  fetch fixed finished window │     │  forwarder-only writes │
                          │  classify (deterministic)    │     │  chain + replay guards │
                          │ identical consensus          ├────►│  latch BLOCK           │
                          │ sign report                  │     │  stale => BLOCK        │
                          └──────────────────────────────┘     └───────────┬────────────┘
                                                                           │ isAllowed()
                                                             ┌─────────────▼────────────┐
                                                             │ GatedToken transfers     │
                                                             └──────────────────────────┘
```

1. **Fetch.** On a cron schedule, every node queries the public Federal Register API for a
   fixed lookback window ending the day before the run, so all nodes see the same finished
   day of publications.
2. **Classify.** A deterministic rules engine ([`my-workflow/regGate.ts`](my-workflow/regGate.ts))
   sorts documents into `STABLECOINS`, `TOKENIZED_SECURITIES`, `DIGITAL_ASSET_MARKETS`,
   `AML_SANCTIONS`. Only watched regulators count: SEC, CFTC, Treasury, OCC, FDIC, Fed,
   FinCEN, OFAC, CFPB, IRS, and the Executive Office of the President.

   | Document type | Status |
   |---|---|
   | Final Rule, Presidential Document | `BLOCK` |
   | Proposed Rule, Notice | `REVIEW` |
   | Anything else | `BLOCK` (unknown fails closed) |

3. **Agree.** Nodes must return byte-identical results. There is no LLM in the decision
   path on purpose: LLM output differs between runs and would break consensus.
4. **Write.** The agreed result is signed and written to
   [`RegGateStatus.sol`](contracts/src/RegGateStatus.sol).
5. **Enforce.** [`GatedToken.sol`](contracts/src/GatedToken.sol) asks the gate before every
   transfer. Strict tokens pass only on `OK`; lenient tokens pass on anything but `BLOCK`.

## Live result (2026-10-18)

A real simulation against the live Federal Register, window 2026-10-05 to 2026-10-18:

| Category | Status | Trigger |
|---|---|---|
| Stablecoins | OK | none in window |
| Tokenized securities | REVIEW | [2026-20466](https://www.federalregister.gov/d/2026-20466) SEC proposed crypto custody rules ("tokenized private funds") |
| Digital asset markets | REVIEW | [2026-21128](https://www.federalregister.gov/d/2026-21128) SEC notice, options on crypto asset trusts |
| AML and sanctions | REVIEW | [2026-20430](https://www.federalregister.gov/d/2026-20430) FinCEN withdrawal of the unhosted-wallet proposal |

Every flagged document was checked by hand. One live false positive was found and fixed:
a CFTC proposal named "Regulation Crypto Asset Transactions" was tagged as tokenized
securities. That rule now applies only to the SEC, with a regression test.

With those statuses, the demo token `gUSD` (stablecoins, lenient) transfers freely and
`gAST` (digital asset markets, strict) is blocked at REVIEW.

## Fail-closed design

| Situation | Result |
|---|---|
| API down, bad JSON, unexpected shape, node disagreement | Nothing written. Contract goes stale, then reads `BLOCK`. |
| Error status with a body that parses as "no results" | Rejected. Never reported as all-OK. |
| Document outside the requested window | Run aborts. The API response is not trusted. |
| No report ever received | `BLOCK` |
| Last report older than `maxAge` | `BLOCK` |
| Matched document of unknown type | `BLOCK` |
| More results than one page holds | Every category floored at `REVIEW` |
| `BLOCK` reported | Latches through later `OK` reports until the reviewer clears it |
| Reviewer cleared, same document still in window | `REVIEW`, never `OK` |
| New blocking document after a clear | Latches again |
| Status page cannot reach the chain | Shows `UNKNOWN`, never `OK` |

**Write access.** Reports are accepted only from the Chainlink forwarder, from the pinned
workflow owner (once set), for this chain, with a strictly increasing timestamp. That
covers the two replay risks Chainlink's consumer-contract docs warn about: cross-chain
replay and same-chain replay of a failed report.

## Layout

```
my-workflow/
  regGate.ts            classifier, parser, query builder, report encoder (pure, deterministic)
  workflow.ts           CRE wiring: cron -> fetch -> consensus -> report -> write
  regGate.test.ts       37 classifier tests
  workflow.test.ts      7 config and handler tests
  e2e.test.ts           7 end-to-end tests: real onCronTrigger, mocked HTTP and chain
contracts/
  src/RegGateStatus.sol    on-chain receiver
  src/GatedToken.sol       demo ERC-20 gated on a category
  test/                    33 Foundry tests
deploy/
  deploy.ts       deploy to Sepolia, update configs and the status page
  status.ts       read the live status and simulate a transfer on each token (no key, no gas)
  address.ts      print the burner's public address for a faucet
docs/
  index.html      live status page (GitHub Pages)
```

## Run it

```bash
# workflow tests and typecheck (from my-workflow/)
bun install
bun run typecheck
bun run test

# contract tests (from contracts/, needs Foundry)
forge test

# simulate against the live Federal Register (from the project root)
cre workflow simulate my-workflow --target staging-settings
```

## Deploy to Sepolia

All scripts run from the project root, so Bun loads `CRE_ETH_PRIVATE_KEY` from `.env`. The
key is never printed. The scripts refuse any chain other than Sepolia.

```bash
bun install --cwd deploy
bun deploy/address.ts          # public address to fund from a Sepolia faucet
bun deploy/deploy.ts           # deploys RegGateStatus + gUSD + gAST, updates configs
cre workflow simulate my-workflow --target staging-settings --broadcast
bun deploy/status.ts           # on-chain status + which tokens can transfer
```

The default forwarder is the Sepolia **simulation** forwarder
(`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`, from Chainlink's forwarder directory).
Confirm it for your org with `cre workflow supported-chains`. The forwarder is immutable
by design, so moving to the production forwarder means redeploying.

## Demo-safe vs deploy-safe

**Demo-safe (this repo):** Sepolia testnet, a throwaway burner key, the simulation forwarder,
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
| Classifier (`regGate.test.ts`) | 37 | 9 of 9 |
| Workflow end to end (`e2e.test.ts`) | 7 | 6 of 6 |
| Config and handler (`workflow.test.ts`) | 7 | |
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
- The status page in a headless browser across live, latched, stale, unreachable and
  not-deployed states, desktop and mobile, light and dark.

## License

MIT. Built by NorthSchema.
