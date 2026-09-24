export function intertrainUsdcBridgeStatus() {
  return {
    routeId: 'arbitrum-one-usdc-to-intertrain-native-wsk',
    available: false as const,
    state: 'awaiting-destination-verification' as const,
    source: {
      networkId: 'arbitrum-one',
      asset: 'USDC',
      tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      bridgeContract: '0x0729F81ACc0948089B0BAcc0685c461F8F54F23B',
    },
    destination: {
      networkId: 'intertrain-mainnet',
      asset: 'WSK',
      kind: 'native' as const,
      decimals: 6,
    },
    reason:
      'The Arbitrum depositForWSK contract is deployed. TsionMarket still needs an independent way to match a confirmed source deposit to native WSK credited to the selected Intertrain account, so deposits remain disabled.',
  }
}
