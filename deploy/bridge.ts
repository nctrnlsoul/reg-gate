// Moves testnet ETH from the burner on Sepolia to the same burner on Base Sepolia,
// through Base's official L1StandardBridge. Needed because faucets that drip Base
// Sepolia ETH now require mainnet holdings.
//
//   bun deploy/bridge.ts                     # dry run: shows what it would send
//   bun deploy/bridge.ts --confirm           # sends 0.02 ETH
//   bun deploy/bridge.ts --amount 0.01 --confirm
//
// Testnet only. The key comes from .env and is never printed. Funds arrive on
// Base Sepolia a few minutes after the Sepolia transaction confirms.

import { parseArgs } from 'node:util'
import { formatEther, parseAbi, parseEther, type Address } from 'viem'
import { assertChain, clients, NETWORKS } from './lib'

// L1StandardBridge for Base Sepolia, on Ethereum Sepolia.
// Source: https://docs.base.org/chain/base-contracts (checked 2026-10-20; bytecode present on chain).
const BASE_SEPOLIA_L1_BRIDGE: Address = '0xfd0Bf71F60660E2f608ed56e1659C450eB113120'
const BRIDGE_ABI = parseAbi(['function depositETH(uint32 minGasLimit, bytes extraData) payable'])
const MAX_AMOUNT = parseEther('0.03') // a burner never needs more than this on a testnet mirror

const { values } = parseArgs({
	options: {
		amount: { type: 'string', default: '0.02' },
		confirm: { type: 'boolean', default: false },
	},
})

const amount = parseEther(values.amount!)
if (amount <= 0n || amount > MAX_AMOUNT) throw new Error(`--amount must be above 0 and at most ${formatEther(MAX_AMOUNT)} ETH`)

const l1 = clients(true, NETWORKS.sepolia)
const l2 = clients(false, NETWORKS['base-sepolia'])
await assertChain(l1.publicClient, NETWORKS.sepolia)
await assertChain(l2.publicClient, NETWORKS['base-sepolia'])

const me = l1.account!.address
const code = await l1.publicClient.getCode({ address: BASE_SEPOLIA_L1_BRIDGE })
if (!code || code === '0x') throw new Error('Bridge address has no code on Sepolia. Refusing to send.')

const l1Bal = await l1.publicClient.getBalance({ address: me })
const l2Before = await l2.publicClient.getBalance({ address: me })
console.log(`Burner:              ${me}`)
console.log(`Sepolia balance:     ${formatEther(l1Bal)} ETH`)
console.log(`Base Sepolia before: ${formatEther(l2Before)} ETH`)
console.log(`Bridge (L1):         ${BASE_SEPOLIA_L1_BRIDGE}`)
console.log(`Amount:              ${formatEther(amount)} ETH -> same address on Base Sepolia\n`)

if (l1Bal < amount + parseEther('0.002')) throw new Error('Not enough Sepolia ETH for the amount plus gas.')
if (!values.confirm) {
	console.log('Dry run. Nothing sent. Re-run with --confirm to send.')
	process.exit(0)
}

const hash = await l1.walletClient!.writeContract({
	address: BASE_SEPOLIA_L1_BRIDGE,
	abi: BRIDGE_ABI,
	functionName: 'depositETH',
	args: [200_000, '0x'],
	value: amount,
})
console.log(`Sepolia tx: ${hash} ... waiting`)
const receipt = await l1.publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error('Bridge deposit reverted on Sepolia.')
console.log(`Confirmed in block ${receipt.blockNumber}: ${NETWORKS.sepolia.explorer}/tx/${hash}`)

console.log('Waiting for it to land on Base Sepolia (usually 1 to 5 minutes)...')
const deadline = Date.now() + 15 * 60_000
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 20_000))
	const now = await l2.publicClient.getBalance({ address: me }).catch(() => l2Before)
	if (now > l2Before) {
		console.log(`Arrived. Base Sepolia balance: ${formatEther(now)} ETH`)
		console.log('\nNext: bun deploy/deploy.ts --network base-sepolia')
		process.exit(0)
	}
	process.stdout.write('.')
}
console.log('\nNot arrived after 15 minutes. It is not lost: check again later with bun deploy/address.ts')
