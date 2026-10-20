// Prints the PUBLIC address of the burner key in .env, so you can paste it
// into a faucet, plus its balance on Sepolia and Base Sepolia. The private key
// itself is never printed.
//
//   bun deploy/address.ts

import { formatEther } from 'viem'
import { clients, NETWORKS } from './lib'

const { account } = clients(true)
console.log(`Burner address (public, safe to share): ${account!.address}`)
for (const net of Object.values(NETWORKS)) {
	try {
		const { publicClient } = clients(false, net)
		const bal = await publicClient.getBalance({ address: account!.address })
		console.log(`${net.label} balance: ${formatEther(bal)} ETH`)
	} catch {
		console.log(`${net.label} balance: could not reach RPC`)
	}
}
