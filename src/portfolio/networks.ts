import type { Environment } from '../config/env.js'

export type Network = {
  networkId: string
  family: 'evm' | 'solana' | 'intertrain'
  name: string
  environment: 'mainnet' | 'testnet' | 'devnet'
  chainId?: number
  cluster?: string
  nativeSymbol: string
  nativeDecimals: number
  rpcKeys: (keyof Environment)[]
  explorer: { name: string; txTemplate: string; addressTemplate: string }
}

export const NETWORKS: Network[] = [
  {
    networkId: 'ethereum-sepolia',
    family: 'evm',
    name: 'Ethereum Sepolia',
    environment: 'testnet',
    chainId: 11155111,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcKeys: ['ETHEREUM_SEPOLIA_RPC_URL', 'ETHEREUM_SEPOLIA_FALLBACK_RPC_URL'],
    explorer: {
      name: 'Etherscan',
      txTemplate: 'https://sepolia.etherscan.io/tx/{hash}',
      addressTemplate: 'https://sepolia.etherscan.io/address/{address}',
    },
  },
  {
    networkId: 'arbitrum-sepolia',
    family: 'evm',
    name: 'Arbitrum Sepolia',
    environment: 'testnet',
    chainId: 421614,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcKeys: ['ARBITRUM_SEPOLIA_RPC_URL', 'ARBITRUM_SEPOLIA_FALLBACK_RPC_URL'],
    explorer: {
      name: 'Arbiscan',
      txTemplate: 'https://sepolia.arbiscan.io/tx/{hash}',
      addressTemplate: 'https://sepolia.arbiscan.io/address/{address}',
    },
  },
  {
    networkId: 'solana-devnet',
    family: 'solana',
    name: 'Solana Devnet',
    environment: 'devnet',
    cluster: 'devnet',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    rpcKeys: ['SOLANA_RPC_URL', 'SOLANA_FALLBACK_RPC_URL'],
    explorer: {
      name: 'Solana Explorer',
      txTemplate: 'https://explorer.solana.com/tx/{hash}?cluster=devnet',
      addressTemplate: 'https://explorer.solana.com/address/{address}?cluster=devnet',
    },
  },
  {
    networkId: 'ethereum-mainnet',
    family: 'evm',
    name: 'Ethereum',
    environment: 'mainnet',
    chainId: 1,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcKeys: ['ETHEREUM_RPC_URLS', 'ETHEREUM_RPC_URL', 'ETHEREUM_FALLBACK_RPC_URL'],
    explorer: {
      name: 'Etherscan',
      txTemplate: 'https://etherscan.io/tx/{hash}',
      addressTemplate: 'https://etherscan.io/address/{address}',
    },
  },
  {
    networkId: 'arbitrum-one',
    family: 'evm',
    name: 'Arbitrum One',
    environment: 'mainnet',
    chainId: 42161,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcKeys: ['ARBITRUM_RPC_URLS', 'ARBITRUM_RPC_URL', 'ARBITRUM_FALLBACK_RPC_URL'],
    explorer: {
      name: 'Arbiscan',
      txTemplate: 'https://arbiscan.io/tx/{hash}',
      addressTemplate: 'https://arbiscan.io/address/{address}',
    },
  },
  {
    networkId: 'solana-mainnet-beta',
    family: 'solana',
    name: 'Solana Mainnet-Beta',
    environment: 'mainnet',
    cluster: 'mainnet-beta',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    rpcKeys: ['SOLANA_MAINNET_RPC_URLS', 'SOLANA_MAINNET_RPC_URL'],
    explorer: {
      name: 'Solana Explorer',
      txTemplate: 'https://explorer.solana.com/tx/{hash}',
      addressTemplate: 'https://explorer.solana.com/address/{address}',
    },
  },
  {
    networkId: 'intertrain-mainnet',
    family: 'intertrain',
    name: 'Intertrain',
    environment: 'mainnet',
    chainId: 4683,
    cluster: 'intertrain-1',
    nativeSymbol: 'WSK',
    nativeDecimals: 6,
    rpcKeys: ['INTERTRAIN_MAINNET_RPC_URLS', 'INTERTRAIN_MAINNET_RPC_URL'],
    explorer: {
      name: 'Intertrain Explorer',
      txTemplate: 'https://explorer.intertrain.online/tx/{hash}',
      addressTemplate: 'https://explorer.intertrain.online/address/{address}',
    },
  },
]

export function enabledNetworks(mode: Environment['NETWORK_MODE']): Network[] {
  return NETWORKS.filter((network) =>
    mode === 'mainnet'
      ? network.environment === 'mainnet'
      : mode === 'testnet'
        ? network.environment === 'testnet'
        : network.environment !== 'mainnet',
  )
}

export const BALANCE_TOKENS: Record<string, Array<{ address: string; symbol: string; decimals: number }>> = {
  'ethereum-mainnet': [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
  ],
  'arbitrum-one': [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
  ],
  'solana-mainnet-beta': [
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', decimals: 9 },
  ],
}
