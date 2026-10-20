// Deploys Reg-Gate to Sepolia:
//   1. RegGateStatus (the receiver the CRE workflow writes to)
//   2. Two demo GatedTokens:
//        gUSD  gated on STABLECOINS, lenient (blocks only on BLOCK)
//        gAST  gated on DIGITAL_ASSET_MARKETS, strict (passes only on OK)
// Then points the workflow config and the status page at the new contract.
//
//   bun deploy/deploy.ts                       # simulation forwarder (default)
//   bun deploy/deploy.ts --forwarder 0x...     # another forwarder
//   bun deploy/deploy.ts --max-age-days 7
//
// Sepolia only. Key comes from .env and is never printed.

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { formatEther, parseEther, type Address } from 'viem'
import {
	assertSepolia,
	clients,
	DEPLOYMENT_FILE,
	type Deployment,
	etherscan,
	loadArtifact,
	parseAddressArg,
	ROOT,
	SEPOLIA_CHAIN_ID,
	SIM_FORWARDER_SEPOLIA,
	writeJson,
} from './lib'

const { values } = parseArgs({
	options: {
		forwarder: { type: 'string' },
		'max-age-days': { type: 'string', default: '7' },
		reviewer: { type: 'string' },
	},
})

const maxAgeDays = Number(values['max-age-days'])
if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 30) {
	throw new Error('--max-age-days must be an integer from 1 to 30')
}
const maxAge = maxAgeDays * 86_400

const { publicClient, walletClient, account } = clients(true)
await assertSepolia(publicClient)

const deployer = account!.address
const forwarder = parseAddressArg(values.forwarder, SIM_FORWARDER_SEPOLIA, '--forwarder')
const reviewer = parseAddressArg(values.reviewer, deployer, '--reviewer')

const balance = await publicClient.getBalance({ address: deployer })
console.log(`Deployer:  ${deployer}`)
console.log(`Balance:   ${formatEther(balance)} Sepolia ETH`)
console.log(`Forwarder: ${forwarder}${forwarder === SIM_FORWARDER_SEPOLIA ? ' (simulation forwarder)' : ''}`)
console.log(`Reviewer:  ${reviewer}`)
console.log(`Max age:   ${maxAgeDays} days\n`)
if (balance < parseEther('0.005')) {
	throw new Error('Balance below 0.005 Sepolia ETH. Fund the burner from a faucet first (bun deploy/address.ts shows the address).')
}

async function deploy(name: 'RegGateStatus' | 'GatedToken', args: unknown[]) {
	const art = loadArtifact(name)
	const hash = await walletClient!.deployContract({ abi: art.abi, bytecode: art.bytecode, args })
	console.log(`  ${name}: tx ${hash} ... waiting`)
	const receipt = await publicClient.waitForTransactionReceipt({ hash })
	if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed`)
	console.log(`  ${name}: ${receipt.contractAddress}`)
	return { address: receipt.contractAddress as Address, tx: hash, block: Number(receipt.blockNumber) }
}

console.log('Deploying RegGateStatus...')
const gate = await deploy('RegGateStatus', [forwarder, BigInt(maxAge), reviewer])

console.log('Deploying demo tokens...')
const supply = parseEther('1000000')
const gUSD = await deploy('GatedToken', ['Gated USD (Reg-Gate demo)', 'gUSD', gate.address, 0, false, supply])
const gAST = await deploy('GatedToken', ['Gated Asset (Reg-Gate demo)', 'gAST', gate.address, 2, true, supply])

const deployment: Deployment = {
	network: 'sepolia',
	chainId: SEPOLIA_CHAIN_ID,
	deployedAt: new Date().toISOString(),
	deployer,
	forwarder,
	maxAgeSeconds: maxAge,
	reviewer,
	regGateStatus: { address: gate.address, tx: gate.tx },
	tokens: [
		{ symbol: 'gUSD', category: 'STABLECOINS', strict: false, address: gUSD.address, tx: gUSD.tx },
		{ symbol: 'gAST', category: 'DIGITAL_ASSET_MARKETS', strict: true, address: gAST.address, tx: gAST.tx },
	],
}
mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true })
writeJson(DEPLOYMENT_FILE, deployment)

// Point the workflow at the real receiver.
for (const f of ['config.staging.json', 'config.production.json']) {
	const p = join(ROOT, 'reg-gate-workflow', f)
	const cfg = JSON.parse(readFileSync(p, 'utf-8'))
	cfg.receiverAddress = gate.address
	writeJson(p, cfg)
}

// Point the status page at it.
writeJson(join(ROOT, 'docs', 'deployment.json'), {
	chainId: SEPOLIA_CHAIN_ID,
	regGateStatus: gate.address,
	forwarder, // the status page reads rejected reports from the forwarder's log
	fromBlock: gate.block, // the status page reads contract events from here
	tokens: deployment.tokens.map(({ symbol, category, strict, address }) => ({ symbol, category, strict, address })),
})

console.log(`\nDone. RegGateStatus: ${etherscan('address', gate.address)}`)
console.log('Updated: reg-gate-workflow/config.*.json, docs/deployment.json, deploy/deployments/sepolia.json')
console.log('\nNext: cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast')
