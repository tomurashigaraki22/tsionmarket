import { createHash } from 'node:crypto'
import { bech32m } from '@scure/base'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getAccountLenForMint,
  getExtensionTypes,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { encodeFunctionData, formatUnits, getAddress, isAddress, parseAbi } from 'viem'
import type { Environment } from '../config/env.js'
import { BALANCE_TOKENS, NETWORKS } from '../portfolio/networks.js'
import type { RpcManager } from '../portfolio/RpcManager.js'
import { isExpectedIntertrainChain, parseIntertrainNativeBalance } from '../portfolio/intertrain.js'
import { AppError } from '../utils/errors.js'
import { canonicalHash, type TradingRepository } from './TradingRepository.js'

const transferAbi = parseAbi(['function transfer(address to,uint256 amount) returns (bool)'])
const HEX = /^(?:[0-9a-f]{2})+$/i
const DECIMAL_RAW = /^[1-9]\d{0,77}$/
// Intertrain's chain_info RPC currently omits fee_minimum. The web-wallet and
// SDK both use one raw native unit as the protocol's default minimum fee.
const INTERTRAIN_DEFAULT_FEE_MINIMUM_RAW = 1n
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export type WithdrawalInput = {
  accountId: string
  assetId: string
  toAddress: string
  amountRaw: string
  idempotencyKey: string
  publicKey?: string | undefined
  paymentOperationId?: string | undefined
  paymentReference?: string | undefined
  paymentExpiresAt?: Date | undefined
}

export class WithdrawalIntentService {
  constructor(
    private readonly repo: TradingRepository,
    private readonly rpc: RpcManager,
    private readonly env: Environment,
  ) {}

  async create(userId: string, input: WithdrawalInput) {
    return this.createIntent(userId, input)
  }

  /** Internal payment flow: caller must derive every transfer field from the persisted payment record. */
  async createPaymentTransfer(
    userId: string,
    input: Omit<WithdrawalInput, 'paymentOperationId' | 'paymentReference' | 'paymentExpiresAt'>,
    payment: { operationId: string; providerReference: string; expiresAt: Date },
  ) {
    return this.createIntent(userId, {
      ...input,
      paymentOperationId: payment.operationId,
      paymentReference: payment.providerReference,
      paymentExpiresAt: payment.expiresAt,
    })
  }

  private async createIntent(userId: string, input: WithdrawalInput) {
    if (!DECIMAL_RAW.test(input.amountRaw) || BigInt(input.amountRaw) <= 0n)
      throw new AppError('INVALID_WITHDRAWAL_AMOUNT', 'Enter a positive amount with supported precision', 400)
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200)
      throw new AppError('INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required', 400)
    const requestFingerprint = canonicalHash({
      accountId: input.accountId,
      assetId: input.assetId,
      toAddress: input.toAddress,
      amountRaw: input.amountRaw,
      paymentOperationId: input.paymentOperationId ?? null,
    })
    const prior = await this.repo.existingIntent(userId, input.idempotencyKey)
    if (prior) {
      const summary = asRecord(prior.normalizedSummary)
      if (prior.intentType !== 'withdrawal' || summary.requestFingerprint !== requestFingerprint)
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This request key was already used for another action',
          409,
        )
      return { intent: prior, existing: true }
    }

    const account = await this.repo.account(userId, input.accountId)
    if (!account) throw new AppError('ACCOUNT_NOT_READY', 'Choose a verified wallet account first', 409)
    const network = NETWORKS.find((item) => item.networkId === account.networkId)
    if (!network) throw new AppError('NETWORK_UNSUPPORTED', 'This wallet network is not supported', 400)

    if (account.family === 'evm') return this.evm(userId, input, account, network, requestFingerprint)
    if (account.family === 'solana') return this.solana(userId, input, account, network, requestFingerprint)
    if (account.family === 'intertrain')
      return this.intertrain(userId, input, account, network, requestFingerprint)
    throw new AppError('NETWORK_UNSUPPORTED', 'No withdrawal adapter exists for this network', 409)
  }

  private async evm(
    userId: string,
    input: WithdrawalInput,
    account: { id: string; networkId: string; address: string; chainId: number | null },
    network: (typeof NETWORKS)[number],
    requestFingerprint: string,
  ) {
    if (!account.chainId || !isAddress(account.address) || !isAddress(input.toAddress))
      throw new AppError('INVALID_ADDRESS', 'Enter a valid EVM destination address', 400)
    const from = getAddress(account.address)
    const to = getAddress(input.toAddress)
    if (from.toLowerCase() === to.toLowerCase())
      throw new AppError('SAME_ADDRESS', 'Choose a different destination address', 400)
    const native = input.assetId === 'native'
    const token = native
      ? null
      : [
          ...(await this.repo.marketTokens(account.networkId)),
          ...(BALANCE_TOKENS[account.networkId] ?? []),
        ].find((candidate) => candidate.address.toLowerCase() === input.assetId.toLowerCase())
    if (!native && !token)
      throw new AppError('TOKEN_NOT_LISTED', 'This asset is not enabled for wallet withdrawals', 400)

    const client = this.rpc.evmClient(network)
    const amount = BigInt(input.amountRaw)
    let txTo: `0x${string}`
    let data: `0x${string}`
    let value: bigint
    let symbol: string
    let decimals: number
    if (native) {
      txTo = to
      data = '0x'
      value = amount
      symbol = network.nativeSymbol
      decimals = network.nativeDecimals
      const balance = await client.getBalance({ address: from })
      if (balance < amount)
        throw new AppError(
          'INSUFFICIENT_ASSET_BALANCE',
          'Native balance is lower than the withdrawal amount',
          409,
        )
    } else {
      txTo = getAddress(token!.address)
      data = encodeFunctionData({
        abi: transferAbi,
        functionName: 'transfer',
        args: [to, amount],
      })
      value = 0n
      symbol = token!.symbol
      decimals = token!.decimals
      const balance = await client.readContract({
        address: txTo,
        abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [from],
      })
      if (balance < amount)
        throw new AppError(
          'INSUFFICIENT_ASSET_BALANCE',
          `${symbol} balance is lower than the withdrawal amount`,
          409,
        )
    }

    const [nonce, gas, fees, nativeBalance] = await Promise.all([
      client.getTransactionCount({ address: from, blockTag: 'pending' }),
      client.estimateGas({ account: from, to: txTo, data, value }),
      client.estimateFeesPerGas(),
      client.getBalance({ address: from }),
    ])
    const maxFeePerGas = fees.maxFeePerGas
    const priority = fees.maxPriorityFeePerGas
    const legacyGasPrice = (fees as unknown as { gasPrice?: bigint }).gasPrice
    const feePerGas = maxFeePerGas ?? legacyGasPrice
    if (feePerGas === undefined)
      throw new AppError('FEE_ESTIMATE_UNAVAILABLE', 'Could not estimate the network fee', 503)
    const estimatedFee = gas * feePerGas
    const bufferedFee = estimatedFee + (estimatedFee * BigInt(this.env.FEE_SAFETY_BUFFER_BPS)) / 10_000n
    const requiredNative = bufferedFee + (native ? amount : 0n)
    if (nativeBalance < requiredNative)
      throw new AppError(
        'INSUFFICIENT_FEE_BALANCE',
        `Keep ${formatUnits(requiredNative, network.nativeDecimals)} ${network.nativeSymbol} available for the amount and estimated fee`,
        409,
      )
    try {
      await client.call({ account: from, to: txTo, data, value })
    } catch (error) {
      throw new AppError(
        'WITHDRAWAL_SIMULATION_FAILED',
        error instanceof Error ? error.message : 'The transaction could not be simulated',
        409,
      )
    }

    const unsigned = {
      family: 'evm',
      networkId: account.networkId,
      from,
      to: txTo,
      payload: {
        kind: native ? 'native-transfer' : 'erc20-transfer',
        chainId: account.chainId,
        data,
        value: `0x${value.toString(16)}`,
        nonce,
        gas: gas.toString(),
        ...(maxFeePerGas !== undefined
          ? { maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: (priority ?? 0n).toString() }
          : { gasPrice: legacyGasPrice?.toString() }),
      },
    }
    return this.persist(userId, input, account, unsigned, {
      action: 'wallet-withdrawal',
      assetSymbol: symbol,
      assetDecimals: decimals,
      amountRaw: input.amountRaw,
      to,
      estimatedNetworkFeeRaw: estimatedFee.toString(),
      networkFeeSymbol: network.nativeSymbol,
      requestFingerprint,
    })
  }

  private async solana(
    userId: string,
    input: WithdrawalInput,
    account: { id: string; networkId: string; address: string },
    network: (typeof NETWORKS)[number],
    requestFingerprint: string,
  ) {
    let from: PublicKey
    let to: PublicKey
    try {
      from = new PublicKey(account.address)
      to = new PublicKey(input.toAddress)
    } catch {
      throw new AppError('INVALID_ADDRESS', 'Enter a valid Solana destination address', 400)
    }
    if (from.equals(to)) throw new AppError('SAME_ADDRESS', 'Choose a different destination address', 400)
    const amount = BigInt(input.amountRaw)
    return this.rpc.solana(network, async (connection) => {
      const instructions = []
      let symbol: string
      let decimals: number
      let rent = 0

      if (input.assetId === 'native') {
        symbol = network.nativeSymbol
        decimals = network.nativeDecimals
        instructions.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amount }))
      } else {
        const meta = [
          ...(await this.repo.marketTokens(account.networkId)),
          ...(BALANCE_TOKENS[account.networkId] ?? []),
        ].find((candidate) => candidate.address === input.assetId)
        if (!meta)
          throw new AppError('TOKEN_NOT_LISTED', 'This asset is not enabled for wallet withdrawals', 400)
        const mint = new PublicKey(input.assetId)
        const mintInfo = await connection.getAccountInfo(mint, 'confirmed')
        if (
          !mintInfo ||
          (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
        )
          throw new AppError(
            'TOKEN_NOT_LISTED',
            'This token mint is not supported by the selected network',
            400,
          )
        const programId = mintInfo.owner
        const mintData = await getMint(connection, mint, 'confirmed', programId)
        if (mintData.decimals !== meta.decimals)
          throw new AppError(
            'TOKEN_METADATA_MISMATCH',
            'Token precision does not match the market catalogue',
            409,
          )
        const extensions = getExtensionTypes(mintData.tlvData)
        if (extensions.includes(ExtensionType.TransferFeeConfig))
          throw new AppError(
            'TOKEN_WITHDRAWAL_UNSUPPORTED',
            'Fee-bearing Token-2022 transfers are not yet supported',
            409,
          )
        const source = getAssociatedTokenAddressSync(
          mint,
          from,
          false,
          programId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        )
        const destination = getAssociatedTokenAddressSync(
          mint,
          to,
          false,
          programId,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        )
        let sourceAccount
        try {
          sourceAccount = await connection.getTokenAccountBalance(source, 'confirmed')
        } catch {
          throw new AppError(
            'INSUFFICIENT_ASSET_BALANCE',
            `No ${meta.symbol} token account exists for this wallet`,
            409,
          )
        }
        if (BigInt(sourceAccount.value.amount) < amount)
          throw new AppError(
            'INSUFFICIENT_ASSET_BALANCE',
            `${meta.symbol} balance is lower than the withdrawal amount`,
            409,
          )
        const destinationInfo = await connection.getAccountInfo(destination, 'confirmed')
        if (!destinationInfo) {
          const accountLength = getAccountLenForMint(mintData)
          rent = await connection.getMinimumBalanceForRentExemption(accountLength)
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              from,
              destination,
              to,
              mint,
              programId,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          )
        }
        instructions.push(
          createTransferCheckedInstruction(
            source,
            mint,
            destination,
            from,
            amount,
            mintData.decimals,
            [],
            programId,
          ),
        )
        symbol = meta.symbol
        decimals = meta.decimals
      }

      const latest = await connection.getLatestBlockhash('confirmed')
      const message = new TransactionMessage({
        payerKey: from,
        recentBlockhash: latest.blockhash,
        instructions,
      }).compileToV0Message()
      const transaction = new VersionedTransaction(message)
      const fee = (await connection.getFeeForMessage(message, 'confirmed')).value
      if (fee === null)
        throw new AppError('FEE_ESTIMATE_UNAVAILABLE', 'Could not estimate the Solana network fee', 503)
      const [nativeBalance, senderLamports] = await Promise.all([
        connection.getBalance(from, 'confirmed'),
        input.assetId === 'native' ? Promise.resolve(0) : Promise.resolve(rent),
      ])
      const requiredNative = BigInt(fee + senderLamports) + (input.assetId === 'native' ? amount : 0n)
      if (BigInt(nativeBalance) < requiredNative)
        throw new AppError(
          'INSUFFICIENT_FEE_BALANCE',
          'SOL balance must cover the transfer, transaction fee, and any recipient token-account rent',
          409,
        )

      try {
        const simulation = await connection.simulateTransaction(transaction, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        })
        if (simulation.value.err) throw new Error(JSON.stringify(simulation.value.err))
      } catch (error) {
        throw new AppError(
          'WITHDRAWAL_SIMULATION_FAILED',
          error instanceof Error ? error.message : 'The Solana transfer could not be simulated',
          409,
        )
      }

      const unsigned = {
        family: 'solana',
        networkId: account.networkId,
        from: account.address,
        to: input.toAddress,
        payload: {
          kind: input.assetId === 'native' ? 'native-transfer' : 'spl-transfer',
          serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
          recentBlockhash: latest.blockhash,
        },
      }
      return this.persist(userId, input, account, unsigned, {
        action: 'wallet-withdrawal',
        assetSymbol: symbol,
        assetDecimals: decimals,
        amountRaw: input.amountRaw,
        to: input.toAddress,
        estimatedNetworkFeeRaw: String(fee),
        networkFeeSymbol: network.nativeSymbol,
        recipientAccountRentRaw: String(rent),
        requestFingerprint,
      })
    })
  }

  private async intertrain(
    userId: string,
    input: WithdrawalInput,
    account: { id: string; networkId: string; address: string },
    network: (typeof NETWORKS)[number],
    requestFingerprint: string,
  ) {
    if (!input.publicKey || !HEX.test(input.publicKey.replace(/^0x/i, '')))
      throw new AppError(
        'INTERTRAIN_PUBLIC_KEY_REQUIRED',
        'Unlock the wallet to prepare this Intertrain transfer',
        409,
      )
    const publicKeyHex = input.publicKey.replace(/^0x/i, '').toLowerCase()
    const publicKey = Buffer.from(publicKeyHex, 'hex')
    if (publicKey.length !== 32 || this.intertrainAddressFromPublicKey(publicKey) !== account.address)
      throw new AppError(
        'INTERTRAIN_PUBLIC_KEY_MISMATCH',
        'Local Intertrain key does not match the registered account',
        400,
      )
    let recipient: string
    try {
      const decoded = bech32m.decodeToBytes(input.toAddress.trim())
      if (decoded.prefix !== 'mna' || decoded.bytes.length !== 21 || decoded.bytes[0] !== 1)
        throw new Error('invalid address')
      recipient = bech32m.encodeFromBytes('mna', decoded.bytes)
    } catch {
      throw new AppError('INVALID_ADDRESS', 'Enter a valid Intertrain mna1 destination address', 400)
    }
    if (recipient === account.address)
      throw new AppError('SAME_ADDRESS', 'Choose a different destination address', 400)
    if (input.assetId !== 'native')
      throw new AppError('TOKEN_NOT_LISTED', 'Only native WSK is supported for Intertrain withdrawals', 400)

    const chainInfo = await this.rpc.intertrainRequest(network, 'chain_info')
    if (!isExpectedIntertrainChain(chainInfo))
      throw new AppError(
        'INTERTRAIN_NETWORK_MISMATCH',
        'The RPC did not identify the expected Intertrain mainnet',
        503,
      )
    const info = asRecord(chainInfo)
    const reportedFeeMinimum = info.fee_minimum
    const feeMinimum =
      reportedFeeMinimum === undefined || reportedFeeMinimum === null
        ? INTERTRAIN_DEFAULT_FEE_MINIMUM_RAW
        : rawInteger(reportedFeeMinimum)
    if (feeMinimum === null)
      throw new AppError(
        'FEE_ESTIMATE_UNAVAILABLE',
        'Intertrain did not provide a valid minimum transaction fee',
        503,
      )
    const accountValue = asRecord(
      await this.rpc.intertrainRequest(network, 'account_get', { address: account.address }),
    )
    const balance = parseIntertrainNativeBalance(accountValue)
    const nonce = rawInteger(accountValue.nonce)
    if (balance === null || nonce === null || nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new AppError('INTERTRAIN_ACCOUNT_INVALID', 'Intertrain returned an invalid balance or nonce', 503)
    const amount = BigInt(input.amountRaw)
    if (BigInt(balance) < amount + feeMinimum)
      throw new AppError(
        'INSUFFICIENT_FEE_BALANCE',
        `Keep ${formatUnits(amount + feeMinimum, 6)} WSK available for the amount and network fee`,
        409,
      )

    const unsigned = {
      family: 'intertrain',
      networkId: account.networkId,
      from: account.address,
      to: recipient,
      payload: {
        kind: 'native-transfer',
        version: 1,
        chainId: 'intertrain-1',
        nonce: Number(nonce),
        amountRaw: amount.toString(),
        feeRaw: feeMinimum.toString(),
        publicKey: publicKeyHex,
        memo: '',
      },
    }
    return this.persist(userId, input, account, unsigned, {
      action: 'wallet-withdrawal',
      assetSymbol: 'WSK',
      assetDecimals: 6,
      amountRaw: input.amountRaw,
      to: recipient,
      estimatedNetworkFeeRaw: feeMinimum.toString(),
      networkFeeSymbol: 'WSK',
      requestFingerprint,
    })
  }

  private persist(
    userId: string,
    input: WithdrawalInput,
    account: { id: string; networkId: string; family?: string },
    unsigned: unknown,
    summary: Record<string, unknown>,
  ) {
    const family = (unsigned as { family?: unknown }).family
    if (typeof family !== 'string')
      throw new AppError('WITHDRAWAL_INTENT_INVALID', 'Transaction family is missing', 500)
    const normalizedSummary = input.paymentOperationId
      ? {
          ...summary,
          paymentOperationId: input.paymentOperationId,
          paymentReference: input.paymentReference,
          paymentPurpose: 'onswitch-offramp',
        }
      : summary
    const ttl = input.paymentExpiresAt
      ? Math.min(
          this.env.TRANSACTION_INTENT_TTL_SECONDS,
          Math.floor((input.paymentExpiresAt.getTime() - Date.now()) / 1000),
        )
      : this.env.TRANSACTION_INTENT_TTL_SECONDS
    if (ttl < 1)
      throw new AppError('PAYMENT_DEPOSIT_EXPIRED', 'The provider deposit instructions have expired', 409)
    return this.repo
      .createIntent({
        userId,
        accountId: account.id,
        quoteId: null,
        key: input.idempotencyKey,
        type: input.paymentOperationId ? 'payment_transfer' : 'withdrawal',
        family,
        networkId: account.networkId,
        unsigned,
        summary: normalizedSummary,
        validation: { ok: true },
        simulation: { ok: true },
        ttl,
      })
      .then((intent) => ({ intent, existing: false }))
  }

  private intertrainAddressFromPublicKey(publicKey: Uint8Array): string {
    const digest = createHash('sha256')
      .update(Buffer.concat([Buffer.from('MNA/address/v1'), Buffer.from(publicKey)]))
      .digest()
    return bech32m.encodeFromBytes('mna', Buffer.concat([Buffer.from([1]), digest.subarray(0, 20)]))
  }
}

function rawInteger(value: unknown): bigint | null {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}
