// Prints the PUBLIC address of the burner key in .env, so you can paste it
// into a Sepolia faucet. The private key itself is never printed.
//
//   bun deploy/address.ts

import { formatEther } from 'viem'
import { clients } from './lib'

const { publicClient, account } = clients(true)
console.log(`Burner address (public, safe to share): ${account!.address}`)
try {
	const bal = await publicClient.getBalance({ address: account!.address })
	console.log(`Sepolia balance: ${formatEther(bal)} ETH`)
} catch {
	console.log('Sepolia balance: could not reach RPC')
}
