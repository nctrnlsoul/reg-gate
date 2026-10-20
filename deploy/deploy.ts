// Deploys Reg-Gate.
//
// Sepolia (the primary chain, default):
//   1. RegGateStatus (the receiver the CRE workflow writes to)
//   2. Two demo GatedTokens:
//        gUSD  gated on STABLECOINS, lenient (blocks only on BLOCK)
//        gAST  gated on DIGITAL_ASSET_MARKETS, strict (passes only on OK)
//   Then points the workflow config and the status page at the new contract.
//
// Base Sepolia (the mirror, --network base-sepolia):
//   RegGateStatus only, then adds it to the workflow config as a mirror chain.
//   The workflow writes the same agreed status there, bound to Base Sepolia's chain ID.
//
//   bun deploy/deploy.ts                          # Sepolia, simulation forwarder
//   bun deploy/deploy.ts --network base-sepolia   # Base Sepolia mirror
//   bun deploy/deploy.ts --forwarder 0x... --author 0x...   # production forwarder: author required
//   bun deploy/deploy.ts --max-age-days 7
//
// Testnets only. Key comes from .env and is never printed.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { formatEther, parseEther, type Address } from 'viem'
import {
	assertChain,
	clients,
	type Deployment,
	deploymentFile,
	loadArtifact,
	networkArg,
	parseAddressArg,
	ROOT,
	writeJson,
} from './lib'

const { values } = parseArgs({
	options: {
		network: { type: 'string', default: 'sepolia' },
		forwarder: { type: 'string' },
		'max-age-days': { type: 'string', default: '7' },
		reviewer: { type: 'string' },
		author: { type: 'string' },
	},
})

const net = networkArg(values.network)
const isMirror = net.name !== 'sepolia'

const maxAgeDays = Number(values['max-age-days'])
if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 30) {
	throw new Error('--max-age-days must be an integer from 1 to 30')
}
const maxAge = maxAgeDays * 86_400

const { publicClient, walletClient, account } = clients(true, net)
await assertChain(publicClient, net)

const deployer = account!.address
const forwarder = parseAddressArg(values.forwarder, net.simForwarder, '--forwarder')
const reviewer = parseAddressArg(values.reviewer, deployer, '--reviewer')
// Simulation mode only behind the CRE simulation forwarder, which checks no DON signatures.
// Any other forwarder is treated as production, and production requires a pinned author.
const simulation = forwarder.toLowerCase() === net.simForwarder.toLowerCase()
const ZERO: Address = '0x0000000000000000000000000000000000000000'
const author = values.author ? parseAddressArg(values.author, ZERO, '--author') : ZERO
if (!simulation && author === ZERO) {
	throw new Error('A production forwarder needs --author <workflow owner address>. The contract refuses every report until one is pinned.')
}

const balance = await publicClient.getBalance({ address: deployer })
console.log(`Network:   ${net.label} (${net.chainId})${isMirror ? ', mirror' : ''}`)
console.log(`Deployer:  ${deployer}`)
console.log(`Balance:   ${formatEther(balance)} ${net.label} ETH`)
console.log(`Forwarder: ${forwarder}${forwarder === net.simForwarder ? ' (simulation forwarder)' : ''}`)
console.log(`Reviewer:  ${reviewer}`)
console.log(`Mode:      ${simulation ? 'simulation (anyone who can reach the simulation forwarder can write; demo only)' : 'production'}`)
console.log(`Author:    ${author === ZERO ? 'not pinned (simulation)' : author}`)
console.log(`Max age:   ${maxAgeDays} days\n`)
if (balance < parseEther('0.005')) {
	throw new Error(
		`Balance below 0.005 ${net.label} ETH. Fund the burner from a faucet first (bun deploy/address.ts shows the address).`,
	)
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
const gate = await deploy('RegGateStatus', [forwarder, BigInt(maxAge), reviewer, author, simulation])

const tokens: Deployment['tokens'] = []
if (!isMirror) {
	console.log('Deploying demo tokens...')
	const supply = parseEther('1000000')
	const gUSD = await deploy('GatedToken', ['Gated USD (Reg-Gate demo)', 'gUSD', gate.address, 0, false, supply])
	const gAST = await deploy('GatedToken', ['Gated Asset (Reg-Gate demo)', 'gAST', gate.address, 2, true, supply])
	tokens.push(
		{ symbol: 'gUSD', category: 'STABLECOINS', strict: false, address: gUSD.address, tx: gUSD.tx },
		{ symbol: 'gAST', category: 'DIGITAL_ASSET_MARKETS', strict: true, address: gAST.address, tx: gAST.tx },
	)
}

const deployment: Deployment = {
	network: net.name,
	chainId: net.chainId,
	deployedAt: new Date().toISOString(),
	deployer,
	forwarder,
	maxAgeSeconds: maxAge,
	reviewer,
	simulation,
	expectedAuthor: author,
	regGateStatus: { address: gate.address, tx: gate.tx },
	tokens,
}
const depFile = deploymentFile(net)
mkdirSync(dirname(depFile), { recursive: true })
writeJson(depFile, deployment)

// Point the workflow at the new receiver: the primary address, or a mirror entry.
for (const f of ['config.staging.json', 'config.production.json']) {
	const p = join(ROOT, 'reg-gate-workflow', f)
	const cfg = JSON.parse(readFileSync(p, 'utf-8'))
	if (isMirror) {
		const others = (cfg.mirrors ?? []).filter((m: { chainSelectorName: string }) => m.chainSelectorName !== net.creChainName)
		cfg.mirrors = [
			...others,
			{ chainSelectorName: net.creChainName, isTestnet: true, receiverAddress: gate.address, gasLimit: '1000000' },
		]
	} else {
		cfg.receiverAddress = gate.address
	}
	writeJson(p, cfg)
}

// Point the status page at it, keeping whatever the other network already recorded.
const pagePath = join(ROOT, 'docs', 'deployment.json')
const page = existsSync(pagePath) ? JSON.parse(readFileSync(pagePath, 'utf-8')) : {}
if (isMirror) {
	const others = (page.mirrors ?? []).filter((m: { chainId: number }) => m.chainId !== net.chainId)
	page.mirrors = [
		...others,
		{ name: net.label, chainId: net.chainId, regGateStatus: gate.address, forwarder, fromBlock: gate.block, explorer: net.explorer },
	]
	writeJson(pagePath, page)
} else {
	writeJson(pagePath, {
		chainId: net.chainId,
		regGateStatus: gate.address,
		forwarder, // the status page reads rejected reports from the forwarder's log
		fromBlock: gate.block, // the status page reads contract events from here
		demoHolder: deployer, // holds the demo supply; the page simulates transfers from it (eth_call only)
		tokens: tokens.map(({ symbol, category, strict, address }) => ({ symbol, category, strict, address })),
		...(page.mirrors ? { mirrors: page.mirrors } : {}),
	})
}

console.log(`\nDone. RegGateStatus: ${net.explorer}/address/${gate.address}`)
console.log(`Updated: reg-gate-workflow/config.*.json, docs/deployment.json, deploy/deployments/${net.name}.json`)
console.log(
	'\nNext: cre workflow simulate reg-gate-workflow --target staging-settings --non-interactive --trigger-index 0 --broadcast',
)
