// Shared setup for the deploy and demo scripts.
//
// Safety rules, enforced here so every script inherits them:
//   - The private key is read ONLY from the CRE_ETH_PRIVATE_KEY environment
//     variable. Run from the project root and Bun loads it from .env for you.
//     It is never printed, logged, or written anywhere.
//   - Testnets only: Sepolia, plus Base Sepolia for the mirror. Any other chain ID
//     aborts before a single transaction.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
	createPublicClient,
	createWalletClient,
	getAddress,
	http,
	isAddress,
	type Address,
	type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, sepolia } from 'viem/chains'

export const SEPOLIA_CHAIN_ID = 11155111
export const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
// MockKeystoneForwarder used by `cre workflow simulate --broadcast` on Sepolia.
// Source: docs.chain.link CRE Forwarder Directory (checked 2026-10-18).
// Confirm for your org with: cre workflow supported-chains
export const SIM_FORWARDER_SEPOLIA: Address = '0x15fC6ae953E024d975e77382eEeC56A9101f9F88'

// Base Sepolia mirror. MockKeystoneForwarder from `cre workflow supported-chains`
// (ethereum-testnet-sepolia-base-1, checked 2026-10-20; bytecode present on chain).
export const BASE_SEPOLIA_CHAIN_ID = 84532
export const SIM_FORWARDER_BASE_SEPOLIA: Address = '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5'

export interface Network {
	name: 'sepolia' | 'base-sepolia'
	label: string
	chain: typeof sepolia | typeof baseSepolia
	chainId: number
	creChainName: string // chain selector name the CRE workflow uses
	rpcEnv: string
	defaultRpc: string
	simForwarder: Address
	explorer: string
}

export const NETWORKS: Record<Network['name'], Network> = {
	sepolia: {
		name: 'sepolia',
		label: 'Sepolia',
		chain: sepolia,
		chainId: SEPOLIA_CHAIN_ID,
		creChainName: 'ethereum-testnet-sepolia',
		rpcEnv: 'SEPOLIA_RPC_URL',
		defaultRpc: DEFAULT_RPC,
		simForwarder: SIM_FORWARDER_SEPOLIA,
		explorer: 'https://sepolia.etherscan.io',
	},
	'base-sepolia': {
		name: 'base-sepolia',
		label: 'Base Sepolia',
		chain: baseSepolia,
		chainId: BASE_SEPOLIA_CHAIN_ID,
		creChainName: 'ethereum-testnet-sepolia-base-1',
		rpcEnv: 'BASE_SEPOLIA_RPC_URL',
		defaultRpc: 'https://base-sepolia-rpc.publicnode.com',
		simForwarder: SIM_FORWARDER_BASE_SEPOLIA,
		explorer: 'https://sepolia.basescan.org',
	},
}

export function networkArg(value: string | undefined): Network {
	const name = value ?? 'sepolia'
	if (name !== 'sepolia' && name !== 'base-sepolia') throw new Error('--network must be sepolia or base-sepolia')
	return NETWORKS[name]
}

export const CATEGORIES = ['STABLECOINS', 'TOKENIZED_SECURITIES', 'DIGITAL_ASSET_MARKETS', 'AML_SANCTIONS'] as const
export const STATUS = ['OK', 'REVIEW', 'BLOCK'] as const

export const ROOT = join(import.meta.dir, '..')
export const DEPLOYMENT_FILE = join(ROOT, 'deploy', 'deployments', 'sepolia.json')

export interface Artifact {
	contractName: string
	abi: any[]
	bytecode: Hex
}

export const loadArtifact = (name: 'RegGateStatus' | 'GatedToken'): Artifact =>
	JSON.parse(readFileSync(join(ROOT, 'deploy', 'artifacts', `${name}.json`), 'utf-8'))

export function rpcUrl(net: Network = NETWORKS.sepolia): string {
	const url = process.env[net.rpcEnv] || net.defaultRpc
	if (!url.startsWith('https://') && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
		throw new Error(`${net.rpcEnv} must be https (or localhost for testing)`)
	}
	return url
}

export function loadAccount() {
	const raw = (process.env.CRE_ETH_PRIVATE_KEY || '').trim()
	if (!raw) {
		throw new Error(
			'CRE_ETH_PRIVATE_KEY is not set. Run this from the reg-gate folder so Bun loads it from .env. Never paste the key into a terminal or chat.',
		)
	}
	const hex = raw.startsWith('0x') ? raw.slice(2) : raw
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		// Do not echo the value, even partially.
		throw new Error('CRE_ETH_PRIVATE_KEY is not 64 hex characters. Fix it in .env (no 0x, no quotes, no spaces).')
	}
	return privateKeyToAccount(`0x${hex}` as Hex)
}

export function clients(withWallet: boolean, net: Network = NETWORKS.sepolia) {
	const transport = http(rpcUrl(net))
	const publicClient = createPublicClient({ chain: net.chain, transport })
	const account = withWallet ? loadAccount() : undefined
	const walletClient = account ? createWalletClient({ chain: net.chain, transport, account }) : undefined
	return { publicClient, walletClient, account }
}

export async function assertChain(publicClient: { getChainId(): Promise<number> }, net: Network) {
	const id = await publicClient.getChainId()
	if (id !== net.chainId) {
		throw new Error(`Refusing to run: RPC reports chain ${id}, expected ${net.label} (${net.chainId}).`)
	}
}

export const assertSepolia = (publicClient: { getChainId(): Promise<number> }) => assertChain(publicClient, NETWORKS.sepolia)

export function parseAddressArg(value: string | undefined, fallback: Address, label: string): Address {
	if (!value) return fallback
	if (!isAddress(value)) throw new Error(`${label} is not a valid address`)
	if (/^0x0{40}$/i.test(value)) throw new Error(`${label} must not be the zero address`)
	return getAddress(value)
}

export const deploymentFile = (net: Network) => join(ROOT, 'deploy', 'deployments', `${net.name}.json`)

export interface Deployment {
	network: Network['name']
	chainId: number
	deployedAt: string
	deployer: Address
	forwarder: Address
	maxAgeSeconds: number
	reviewer: Address
	simulation: boolean // true only behind the CRE simulation forwarder (demo)
	expectedAuthor: Address // zero only in simulation mode
	regGateStatus: { address: Address; tx: Hex }
	tokens: { symbol: string; category: string; strict: boolean; address: Address; tx: Hex }[]
}

export function loadDeployment(): Deployment {
	if (!existsSync(DEPLOYMENT_FILE)) {
		throw new Error('No deployment found. Run: bun deploy/deploy.ts')
	}
	return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf-8'))
}

export function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export const etherscan = (kind: 'address' | 'tx', v: string) => `https://sepolia.etherscan.io/${kind}/${v}`
