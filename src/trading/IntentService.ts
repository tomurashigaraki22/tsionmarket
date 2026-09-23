/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- persisted provider snapshot is validated before transaction construction */
import { VersionedTransaction } from '@solana/web3.js'
import { encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem'
import type { Environment } from '../config/env.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { AppError } from '../utils/errors.js'
import type { TradingRepository } from './TradingRepository.js'

const allowanceAbi = parseAbi(['function allowance(address owner,address spender) view returns (uint256)'])
const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const approveAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])
const zero = '0x0000000000000000000000000000000000000000'
const wrapped: Record<string, string> = {
  'ethereum-mainnet': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  'arbitrum-one': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
}
const asRecord = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}

export class IntentService {
  constructor(
    private repo: TradingRepository,
    private rpc: RpcManager,
    private env: Environment,
  ) {}
  async create(userId: string, input: { quoteId: string; idempotencyKey: string }) {
    const existing = await this.repo.existingIntent(userId, input.idempotencyKey)
    if (existing) {
      if (existing.quoteId !== input.quoteId)
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was already used for another quote',
          409,
        )
      return { intent: existing, existing: true }
    }
    const quote = await this.repo.quote(userId, input.quoteId)
    if (!quote) throw new AppError('QUOTE_NOT_FOUND', 'Quote was not found', 404)
    if (quote.expiresAt.getTime() <= Date.now()) throw new AppError('QUOTE_EXPIRED', 'Quote has expired', 409)
    const account = await this.repo.account(userId, quote.sourceAccountId)
    if (!account) throw new AppError('ACCOUNT_NOT_READY', 'Source account is unavailable', 409)
    const snapshot = asRecord(quote.providerSnapshot),
      request = asRecord(snapshot.transactionRequest)
    if (account.family === 'evm')
      return this.evm(userId, input.idempotencyKey, quote, account, request, snapshot)
    if (account.family === 'solana') return this.solana(userId, input.idempotencyKey, quote, account, request)
    throw new AppError('NETWORK_UNSUPPORTED', 'No intent adapter exists for this network', 409)
  }
  private async evm(
    userId: string,
    key: string,
    quote: any,
    account: any,
    request: Record<string, any>,
    snapshot: Record<string, any>,
  ) {
    if (
      !account.chainId ||
      !isAddress(account.address) ||
      !isAddress(String(request.to)) ||
      typeof request.data !== 'string' ||
      !/^0x[0-9a-f]*$/i.test(request.data)
    )
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned an invalid EVM transaction', 502)
    if (request.from && String(request.from).toLowerCase() !== account.address.toLowerCase())
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned the wrong sender', 502)
    const network = (await import('../portfolio/networks.js')).NETWORKS.find(
        (n) => n.networkId === account.networkId,
      )!,
      client = this.rpc.evmClient(network),
      from = getAddress(account.address),
      sellToken =
        wrapped[account.networkId]?.toLowerCase() === quote.sellToken.toLowerCase() ? zero : quote.sellToken
    if (sellToken !== zero) {
      if (!isAddress(sellToken) || !isAddress(String(quote.approvalAddress)))
        throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned an invalid approval target', 502)
      const token = getAddress(sellToken),
        spender = getAddress(String(quote.approvalAddress)),
        [allowance, tokenBalance] = await Promise.all([
          client.readContract({
            address: token,
            abi: allowanceAbi,
            functionName: 'allowance',
            args: [from, spender],
          }),
          client.readContract({ address: token, abi: balanceAbi, functionName: 'balanceOf', args: [from] }),
        ])
      if (tokenBalance < BigInt(quote.sellAmountRaw))
        throw new AppError('INSUFFICIENT_ASSET_BALANCE', 'Token balance is insufficient', 409)
      if (allowance < BigInt(quote.sellAmountRaw)) {
        const data = encodeFunctionData({
            abi: approveAbi,
            functionName: 'approve',
            args: [spender, BigInt(quote.sellAmountRaw)],
          }),
          nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' }),
          gas = await client.estimateGas({ account: from, to: token, data, value: 0n }),
          fees = await client.estimateFeesPerGas(),
          nativeBalance = await client.getBalance({ address: from }),
          approvalFee = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n)
        if (nativeBalance < approvalFee)
          throw new AppError(
            'INSUFFICIENT_FEE_BALANCE',
            'Native balance is insufficient for approval gas',
            409,
          )
        const unsigned = {
          family: 'evm',
          networkId: account.networkId,
          from,
          to: token,
          payload: {
            kind: 'erc20-approve',
            chainId: account.chainId,
            data,
            value: '0x0',
            nonce,
            gas: gas.toString(),
            maxFeePerGas: fees.maxFeePerGas?.toString(),
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
            gasPrice: (fees as unknown as { gasPrice?: bigint }).gasPrice?.toString(),
          },
        }
        await client.call({ account: from, to: token, data })
        const intent = await this.repo.createIntent({
          userId,
          accountId: account.id,
          quoteId: quote.id,
          key,
          type: 'erc20_approval',
          family: 'evm',
          networkId: account.networkId,
          unsigned,
          summary: { action: 'approve', token, spender, amountRaw: quote.sellAmountRaw },
          validation: { ok: true },
          simulation: { ok: true },
          ttl: this.env.TRANSACTION_INTENT_TTL_SECONDS,
          status: 'awaiting_approval',
        })
        return { intent, existing: false, requiresApproval: true }
      }
    }
    const to = getAddress(String(request.to)),
      data = request.data as `0x${string}`,
      value = BigInt(String(request.value ?? '0')),
      nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' }),
      gas = BigInt(
        String(
          request.gasLimit ?? request.gas ?? (await client.estimateGas({ account: from, to, data, value })),
        ),
      ),
      fees = await client.estimateFeesPerGas(),
      nativeBalance = await client.getBalance({ address: from }),
      fee = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n),
      bufferedFee = fee + (fee * BigInt(this.env.FEE_SAFETY_BUFFER_BPS)) / 10_000n
    if (nativeBalance < value + bufferedFee)
      throw new AppError(
        sellToken === zero ? 'INSUFFICIENT_ASSET_BALANCE' : 'INSUFFICIENT_FEE_BALANCE',
        'Native balance is insufficient for the swap and reserved gas',
        409,
      )
    const unsigned = {
      family: 'evm',
      networkId: account.networkId,
      from,
      to,
      payload: {
        kind: 'spot-swap',
        router: 'lifi',
        integrator: this.env.LIFI_INTEGRATOR,
        chainId: account.chainId,
        data,
        value: `0x${value.toString(16)}`,
        nonce,
        gas: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
        gasPrice: (fees as unknown as { gasPrice?: bigint }).gasPrice?.toString(),
      },
    }
    await client.call({ account: from, to, data, value })
    const intent = await this.repo.createIntent({
      userId,
      accountId: account.id,
      quoteId: quote.id,
      key,
      type: 'swap',
      family: 'evm',
      networkId: account.networkId,
      unsigned,
      summary: {
        action: 'spot-swap',
        provider: 'LI.FI',
        integrator: this.env.LIFI_INTEGRATOR,
        sellToken: quote.sellToken,
        buyToken: quote.buyToken,
        sellAmountRaw: quote.sellAmountRaw,
        minimumBuyAmountRaw: quote.minimumBuyAmountRaw,
        tool: String(snapshot.tool ?? 'LI.FI'),
      },
      validation: { ok: true, requiredNativeRaw: (value + bufferedFee).toString() },
      simulation: { ok: true },
      ttl: this.env.TRANSACTION_INTENT_TTL_SECONDS,
    })
    return { intent, existing: false, requiresApproval: false }
  }
  private async solana(userId: string, key: string, quote: any, account: any, request: Record<string, any>) {
    if (typeof request.data !== 'string')
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned no Solana transaction', 502)
    let transaction: VersionedTransaction
    try {
      transaction = VersionedTransaction.deserialize(Buffer.from(request.data, 'base64'))
    } catch {
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned malformed Solana transaction data', 502)
    }
    const keys = transaction.message.staticAccountKeys.map((k) => k.toBase58())
    if (keys[0] !== account.address)
      throw new AppError('PROVIDER_QUOTE_INVALID', 'LI.FI returned the wrong Solana fee payer', 502)
    const network = (await import('../portfolio/networks.js')).NETWORKS.find(
      (n) => n.networkId === account.networkId,
    )!
    const simulation = await this.rpc.solana(network, (c) =>
      c.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true }),
    )
    if (simulation.value.err)
      throw new AppError('TRANSACTION_SIMULATION_FAILED', 'Solana swap simulation failed', 409, {
        error: simulation.value.err,
        logs: simulation.value.logs?.slice(-10),
      })
    const unsigned = {
      family: 'solana',
      networkId: account.networkId,
      from: account.address,
      to: account.address,
      payload: {
        kind: 'lifi-swap',
        integrator: this.env.LIFI_INTEGRATOR,
        serializedTransaction: request.data,
        feePayer: account.address,
      },
    }
    const intent = await this.repo.createIntent({
      userId,
      accountId: account.id,
      quoteId: quote.id,
      key,
      type: 'swap',
      family: 'solana',
      networkId: account.networkId,
      unsigned,
      summary: {
        action: 'spot-swap',
        provider: 'LI.FI',
        integrator: this.env.LIFI_INTEGRATOR,
        sellToken: quote.sellToken,
        buyToken: quote.buyToken,
        sellAmountRaw: quote.sellAmountRaw,
        minimumBuyAmountRaw: quote.minimumBuyAmountRaw,
      },
      validation: { ok: true, feePayer: account.address, accountKeys: keys.length },
      simulation: { ok: true, unitsConsumed: simulation.value.unitsConsumed },
      ttl: this.env.TRANSACTION_INTENT_TTL_SECONDS,
    })
    return { intent, existing: false, requiresApproval: false }
  }
}
