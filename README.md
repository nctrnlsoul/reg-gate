# Reg-Gate

A Chainlink CRE workflow that watches U.S. Federal Register publications and writes a
fail-closed regulatory status on-chain, per asset category, that token contracts can
check before transfers.

> Reg-Gate flags regulatory publications for human review. It is not legal advice and
> does not interpret the law.

## How it works

1. **Fetch.** On a cron schedule, every node in the Chainlink DON queries the public
   Federal Register API (no key) for documents in a fixed lookback window that ends
   the day before the run, so all nodes see the same finished day of publications.
2. **Classify.** A deterministic rules engine (`my-workflow/regGate.ts`) sorts each
   document into four categories: `STABLECOINS`, `TOKENIZED_SECURITIES`,
   `DIGITAL_ASSET_MARKETS`, `AML_SANCTIONS`. Only watched financial regulators count
   (SEC, CFTC, Treasury, OCC, FDIC, Fed, FinCEN, OFAC, CFPB, IRS, Executive Office of
   the President). Severity comes from document type:

   | Document type | Status |
   |---|---|
   | Final Rule, Presidential Document | `BLOCK` |
   | Proposed Rule, Notice | `REVIEW` |
   | Anything else | `BLOCK` (unknown fails closed) |

3. **Agree.** Nodes must return byte-identical results (identical consensus). No LLM
   in the decision path, because LLM output differs between runs and would break
   consensus.
4. **Write.** The agreed result is signed and written to `RegGateStatus.sol`.

## Fail-closed design

| Situation | Result |
|---|---|
| API down, bad JSON, unexpected shape, node disagreement | Nothing written. Contract goes stale, then reads `BLOCK`. |
| No report ever received | `BLOCK` |
| Last report older than `maxAge` | `BLOCK` |
| Matched document of unknown type | `BLOCK` |
| More results than one page holds (truncated) | Every category floored at `REVIEW` |
| `BLOCK` reported | Latches. Stays `BLOCK` through later `OK` reports until the reviewer clears it. |
| Reviewer cleared, same document still in window | `REVIEW`, never `OK` |
| A new blocking document after a clear | Latches again |

The contract accepts reports only from the Chainlink forwarder, from the pinned workflow
owner, for this chain, with a strictly increasing timestamp (replay protection).

Consumers choose a policy: `isAllowed(category, true)` passes only `OK`;
`isAllowed(category, false)` passes anything but `BLOCK`.

## Layout

```
my-workflow/
  regGate.ts          classifier, parser, query builder, report encoder (pure, deterministic)
  regGate.test.ts     36 tests
  workflow.ts         CRE wiring: cron -> fetch -> consensus -> report -> write
  workflow.test.ts    7 tests (config validation, handler registration)
contracts/
  src/RegGateStatus.sol      on-chain receiver
  test/RegGateStatus.t.sol   24 Foundry tests
```

## Run it

```bash
# workflow tests (from my-workflow/)
bun test regGate.test.ts workflow.test.ts

# typecheck (from my-workflow/)
bun run typecheck

# simulate (from project root)
cre workflow simulate my-workflow --target staging-settings

# contract tests (from contracts/, needs Foundry)
forge test
```

## Demo-safe vs deploy-safe

**Demo-safe (current state):** simulation only. `receiverAddress` in the config is a
placeholder. Without `--broadcast`, the simulator does not send any transaction.

**Before any real deployment:**
1. Deploy `RegGateStatus` to Sepolia with the CRE forwarder address for that chain,
   a `maxAge` (suggested: 2x the cron interval), and a reviewer address.
2. Set `receiverAddress` in the config to the deployed contract.
3. Call `setExpectedAuthor(<workflow owner address>)`. Leave it unset only for local
   simulation, where the mock forwarder supplies no metadata.
4. Never put a funded key in `.env`. Use a dedicated deployer wallet.

## Verification

- Classifier: 36 tests. 8 planted bugs (mutants), all caught.
- Contract: 24 tests. 12 planted bugs, all caught.
- Agency slugs and document-type strings checked against the live Federal Register API
  on 2026-10-18.
