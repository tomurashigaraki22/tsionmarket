# TsionMarket Phase 3 — Frontend Wallet, Envelope Encryption, PIN Signing, and Network Expansion Plan

**Audience:** TsionMarket frontend team  
**Backend repository:** `tsionmarket`  
**Status:** Implementation-ready frontend contract  
**Scope:** Frontend wallet provisioning, envelope encryption, passphrase/PIN unlock, local signing, ownership registration, and extensible network onboarding

---

## 1. Outcome

Build a self-custodial frontend wallet system in which:

1. Wallet keys are generated only in the frontend on a secure browser context.
2. One random wallet data-encryption key (DEK) encrypts all account private keys.
3. A user-chosen passphrase of **at least 12 characters** derives a key-encryption key (KEK) that wraps the DEK.
4. A device PIN can unlock the same DEK for transaction signing without replacing the passphrase or wallet.
5. The PIN wrapper is device-bound so a stolen encrypted package does not expose a portable numeric-PIN brute-force target.
6. Plaintext private keys and the DEK exist only in memory and are wiped as soon as practical.
7. The backend receives only public keys, addresses, network metadata, signed ownership proofs, and signed transactions—never passphrases, PINs, private keys, DEKs, or recovery secrets.
8. Adding a network is registry-driven and safe:
   - a new network in an existing family reuses the existing family account;
   - a genuinely new family creates one new local account;
   - retries never generate duplicate keys;
   - interrupted operations resume cleanly.

This plan is for the frontend. The backend implementation should only provide the public network catalogue, ownership challenge, public account registration, and later transaction-intent APIs.

---

## 2. Reference implementation findings

The reviewed `dashboard-revamp` implementation already demonstrates the correct high-level model:

- `package-crypto.ts` creates a random 32-byte DEK.
- Account secret material is encrypted with AES-256-GCM, a random 12-byte IV, and account-specific AAD.
- The passphrase derives a wrapping key and wraps the DEK.
- A PIN derives a separate wrapping key and wraps the same DEK.
- `unlock-state.ts` keeps the unlocked DEK in module memory, with idle and absolute expiry.
- Signing decrypts only the required account secret from the package.
- `wallet-security.ts` can add a missing chain-family account without changing existing addresses.

TsionMarket should reuse those concepts, but not copy the implementation unchanged.

### Required improvements over the reference

1. The reference passphrase/PIN KDF uses PBKDF2-SHA-256. TsionMarket should use a versioned Argon2id implementation after browser/device benchmarking, with a reviewed fallback policy only where Argon2id is genuinely unavailable.
2. A numeric PIN-derived wrapper stored directly beside ciphertext permits offline guessing. TsionMarket must place the PIN envelope behind a device-bound, non-exportable WebCrypto key (or native secure storage in a native client).
3. The reference `addWalletChains` function scans a hard-coded family list and adds every missing family. TsionMarket must use a backend-driven network catalogue and let users add one intended network/family at a time.
4. Network metadata and explorer mappings must not be spread through multiple hard-coded maps. One registry must drive provisioning, display, validation, signing adapters, icons, capabilities, and explorer URLs.
5. The reference uploads an encrypted package to its crypto backend. TsionMarket Phase 3 stores its encrypted package in frontend-controlled IndexedDB and supports explicit encrypted backup/export; the TsionMarket backend stores public metadata only.

---

## 3. Security boundaries

### Frontend owns

- Cryptographically secure key generation.
- DEK generation.
- Private-key encryption/decryption.
- Passphrase and PIN KDF execution.
- Envelope creation and validation.
- IndexedDB encrypted-package storage.
- In-memory unlock state.
- Local transaction signing.
- Secret wiping.
- Encrypted backup export/import.

### Backend owns

- User authentication.
- Enabled network catalogue and capabilities.
- One-time wallet ownership challenges.
- Public account/address registration.
- Ownership-safe wallet metadata reads.
- Transaction construction, policy validation, simulation, submission, and reconciliation in later phases.

### The backend must never receive

- Wallet passphrase or PIN.
- Passphrase/PIN KDF output.
- Plaintext private key, seed, mnemonic, or DEK.
- Device wrapping key.
- Decrypted wallet package.
- Recovery secret.

### Explicit threat assumptions

The design protects a copied database, copied encrypted backup, backend compromise, network interception under TLS, and casual local-storage inspection. It cannot protect a user from fully compromised browser JavaScript, a malicious extension with page access, an already-unlocked compromised device, screen/key logging, or a user voluntarily disclosing the passphrase.

---

## 4. Cryptographic architecture

```text
User passphrase (12+ chars)
          |
          v
Argon2id(passphrase, passphraseSalt, versioned parameters)
          |
          v
Passphrase KEK ---------------------+
                                     |
Device PIN                           | AES-256-GCM wraps
    |                                | the same random DEK
    v                                |
Argon2id(PIN, pinSalt)               |
    |                                |
    + device-bound outer key --------+
                                     |
                               32-byte wallet DEK
                                     |
                    +----------------+----------------+
                    |                |                |
                    v                v                v
              EVM private key   Solana secret   future-family key
                 AES-GCM           AES-GCM           AES-GCM
```

The passphrase and PIN do not directly encrypt every wallet private key. They provide independent ways to unwrap the random DEK. This allows a user to change a passphrase or PIN without changing wallet addresses or re-encrypting every account secret.

### Required primitives

- Randomness: `crypto.getRandomValues` only.
- Account encryption: AES-256-GCM.
- DEK: 32 random bytes per wallet.
- IV: fresh random 12 bytes for every AES-GCM operation; never reuse an IV with the same key.
- Authentication tag: 128-bit GCM tag appended to ciphertext by WebCrypto.
- Passphrase KDF: Argon2id, versioned and benchmarked.
- PIN KDF: Argon2id, versioned and benchmarked separately.
- Encoding: base64url without padding for binary JSON fields.
- Hashing/HKDF where required: SHA-256/HKDF-SHA-256.
- Comparison: constant-time comparison for verifier/fingerprint values where practical.

Do not invent cryptographic algorithms or use unauthenticated AES modes.

---

## 5. Passphrase requirements

- Minimum length: **12 characters**.
- Maximum input length: 1,024 UTF-8 characters to prevent resource abuse.
- Do not silently trim, lowercase, or otherwise transform the passphrase before KDF derivation.
- Confirmation must match the exact original input.
- Show strength guidance, permit paste/password managers, and do not require arbitrary character-class composition.
- Block a small bundled list of obviously compromised passwords; optionally use a privacy-preserving breached-password lookup.
- Never persist the passphrase in React state longer than the active form needs it.
- Clear the form value after success, cancel, route change, and component unmount.
- Never place it in URL state, query keys, analytics, error metadata, logs, crash reports, Redux/Zustand persistence, localStorage, sessionStorage, or IndexedDB.

### Proposed passphrase KDF profile

Use a versioned profile rather than unversioned constants:

```ts
type Argon2idProfile = {
  kind: 'argon2id'
  version: 1
  memoryKiB: 65536
  iterations: 3
  parallelism: 1
  salt: string // 16 or 32 random bytes, base64url
  outputBytes: 32
}
```

Benchmark on the slowest supported mobile browser. Target roughly 500–1,500 ms for passphrase unlock. If parameters change, add a new profile version and rewrap the DEK after a successful old-profile unlock. Never silently reinterpret an existing envelope.

---

## 6. Wallet package format

Use a strictly versioned frontend-owned document.

```ts
type EncryptedWalletPackageV1 = {
  format: 'tsionmarket-wallet-package'
  formatVersion: 1
  walletId: string
  revision: number
  dekVersion: 1
  createdAt: string
  updatedAt: string
  accounts: EncryptedWalletAccount[]
  envelopes: WalletEnvelope[]
  networkBindings: NetworkBinding[]
  integrity: {
    canonicalization: 'jcs-v1'
    packageFingerprint: string
  }
}

type EncryptedWalletAccount = {
  accountId: string
  family: string
  algorithm: 'secp256k1' | 'ed25519'
  keyType: 'private-key' | 'seed' | 'opaque'
  publicKey: string
  canonicalAddress: string
  encryptedKeyMaterial: {
    algorithm: 'AES-256-GCM'
    ciphertext: string
    iv: string
    aad: string
    dekVersion: 1
    encoding: 'base64url'
  }
  derivationMetadata: Record<string, unknown>
  createdAt: string
}

type NetworkBinding = {
  networkId: string
  family: string
  accountId: string
  address: string
  state: 'pending-registration' | 'active' | 'registration-failed' | 'network-disabled'
  operationId: string
}
```

### Canonical AAD

AAD prevents ciphertext from being moved between wallets/accounts/envelopes.

```text
Account key:  tsionmarket:wallet:<walletId>:account:<accountId>:dek:<dekVersion>
Passphrase:   tsionmarket:wallet:<walletId>:envelope:passphrase:<envelopeId>:v1
PIN inner:    tsionmarket:wallet:<walletId>:envelope:pin:<deviceId>:<envelopeId>:v1
PIN outer:    tsionmarket:wallet:<walletId>:device:<deviceId>:pin-envelope:v1
Backup:       tsionmarket:wallet:<walletId>:backup:<formatVersion>
```

AAD must be produced by one shared function and tested with fixed vectors. Do not allow components to assemble these strings independently.

### Account plaintext

Before encryption, serialize a minimal versioned object or fixed byte format:

```ts
type AccountSecretV1 = {
  version: 1
  family: string
  algorithm: string
  encoding: 'raw-base64url' | 'hex'
  secret: string
}
```

Validate this structure after decryption before passing bytes into a chain signer.

---

## 7. Envelope types

### Passphrase envelope

```ts
type PassphraseEnvelopeV1 = {
  envelopeId: string
  purpose: 'passphrase'
  methodVersion: 1
  wrappedDek: string
  iv: string
  aad: string
  kdf: Argon2idProfile
}
```

Setup:

1. Generate the wallet DEK.
2. Generate a unique passphrase salt.
3. Derive the passphrase KEK with Argon2id.
4. Wrap the DEK using AES-256-GCM and passphrase AAD.
5. Wipe the KEK and temporary passphrase byte buffers.

Unlock:

1. Validate package and KDF bounds before expensive work.
2. Derive the KEK using stored versioned parameters.
3. Unwrap the DEK.
4. On authentication failure, return one generic incorrect-passphrase result.
5. Wipe KEK/salt buffers.

### Device-bound PIN envelope

A numeric PIN has low entropy. Do **not** store only `AES-GCM(Argon2id(PIN), DEK)` in a portable package.

On each device:

1. Generate a non-exportable AES-256-GCM `CryptoKey` with WebCrypto.
2. Store that `CryptoKey` in IndexedDB using structured clone; never export raw key bytes.
3. Derive a PIN KEK with Argon2id and a random PIN salt.
4. Wrap the wallet DEK with the PIN KEK to form an inner PIN envelope.
5. Encrypt the complete inner PIN envelope with the non-exportable device key and device-specific AAD.
6. Store only the outer ciphertext, IV, device ID, PIN KDF metadata, and failure-policy metadata.

```ts
type DevicePinEnvelopeV1 = {
  envelopeId: string
  purpose: 'device-pin'
  methodVersion: 1
  deviceId: string
  outerCiphertext: string
  outerIv: string
  outerAad: string
  createdAt: string
}
```

The device key and PIN envelope remain local to that device and are excluded from portable encrypted backups by default. A new device uses the passphrase, then enrolls a new PIN.

### PIN policy

- PIN format: 6–12 digits if product requires numeric entry.
- Reject repeated/sequential obvious values such as `000000`, `123456`, and date-like trivial patterns.
- Require a successful passphrase unlock before enrolling, changing, or resetting the PIN.
- Five failed attempts trigger an escalating delay and require passphrase unlock before further PIN use on that device.
- Failure counters and lock state are local defense-in-depth, not the primary cryptographic protection.
- “Forgot PIN” deletes the local PIN envelope only; it never creates a new wallet.
- Passphrase unlock remains available at all times.
- Do not synchronize PIN envelopes between devices.

For native mobile clients, replace the IndexedDB device key with Keychain/Keystore-backed non-exportable key material.

---

## 8. Local storage architecture

Use IndexedDB, not localStorage.

Recommended stores:

```text
tsionmarket-wallet-v1
├── packages            key: walletId -> encrypted package
├── device-keys         key: deviceId -> non-exportable CryptoKey
├── device-pin-envelopes key: walletId:deviceId -> outer PIN envelope
├── operations          key: operationId -> resumable provisioning journal
└── metadata            active wallet, schema version, last lock reason
```

### Atomic persistence

- Write package, network bindings, and operation journal in one IndexedDB transaction.
- Use package `revision` compare-and-swap semantics.
- Use `navigator.locks` for wallet mutations where supported.
- Add a `BroadcastChannel` lock/version notification so another tab immediately locks or reloads package metadata after mutation.
- Never overwrite a newer revision from a stale tab.
- Keep a last-known-good encrypted package until the new revision and public registration finish.
- Store no plaintext secrets, passphrases, PINs, or DEKs.

### Backup

- Export only the encrypted portable package.
- Exclude the device PIN envelope and non-exportable device key.
- Include format version, checksum/fingerprint, wallet ID, public account summary, and creation time.
- Restore into a staging record, validate fully, unlock with passphrase, verify that derived public keys/addresses match the stored summary, then atomically activate.
- Never replace an active package before validation succeeds.

---

## 9. Unlock state and signing policy

### In-memory unlock session

The DEK may remain only in module/worker memory:

```ts
type WalletUnlockSession = {
  walletId: string
  userId: string
  dek: Uint8Array
  method: 'passphrase' | 'pin'
  unlockedAt: number
  lastActivityAt: number
  idleExpiresAt: number
  absoluteExpiresAt: number
  confirmationExpiresAt: number
}
```

Recommended defaults:

- Idle unlock: 15 minutes.
- Absolute unlock: 8 hours.
- Fresh signing confirmation: 2 minutes after passphrase or PIN entry.
- Manual lock: immediate.
- Account logout/user switch: immediate.
- Browser `pagehide`, visibility timeout, and cross-tab lock: explicit policy and tests.

Use a dedicated wallet service or Web Worker boundary rather than placing the DEK in React context/state. React components should receive only `locked/unlocked`, expiry, and action methods.

### Signing flow

```text
User requests transaction
        |
        v
Frontend requests backend intent
        |
        v
Display exact network, asset, amount, destination, and fee
        |
        v
Require active fresh confirmation
  | passphrase | device PIN |
        |
        v
Load encrypted account secret from IndexedDB
        |
        v
Decrypt only that account with the in-memory DEK
        |
        v
Verify intent account/network/from-address binding
        |
        v
Sign exact reviewed payload locally
        |
        v
Wipe plaintext key immediately
        |
        v
Submit signed payload to backend
```

Both passphrase and PIN unlock must be able to authorize signing. A general unlocked session may display balances, but signing requires the configured fresh-confirmation window. Sensitive actions can require passphrase even when a PIN session exists.

### Mandatory signing checks

- Selected account belongs to the intent's chain family.
- Stored canonical address equals intent `from`/fee-payer.
- Network ID and chain ID match registry metadata.
- Destination, value, calldata/instructions, nonce/blockhash, and fee fields match the reviewed intent.
- Intent is not expired or already submitted.
- Decrypted public key/address recomputes to the package's public metadata.
- Plaintext key is wiped in `finally`, including exceptions and user cancellation.

---

## 10. Network architecture

The frontend must distinguish:

- **Chain family/account:** one cryptographic identity and signing adapter, such as `evm` with secp256k1.
- **Network:** a deployment using that family, such as Ethereum mainnet, Arbitrum, Base, or an EVM testnet.

Adding Base to a wallet that already has an EVM account must not generate another EVM private key unless multi-account support is explicitly introduced later.

### Backend-driven network descriptor

The frontend consumes `GET /v1/networks`:

```ts
type NetworkDescriptor = {
  id: string
  catalogueVersion: number
  family: string
  environment: 'testnet' | 'mainnet'
  displayName: string
  shortName: string
  chainId?: number
  nativeAsset: { symbol: string; name: string; decimals: number; iconUrl?: string }
  addressFormat: string
  explorer: {
    name: string
    addressUrlTemplate: string
    transactionUrlTemplate: string
  }
  wallet: {
    algorithm: 'secp256k1' | 'ed25519'
    keyType: 'private-key' | 'seed' | 'opaque'
    accountReuseScope: 'family' | 'network'
    provisioningAdapter: string
    signingAdapter: string
  }
  capabilities: {
    balance: boolean
    transfer: boolean
    tokenTransfer: boolean
    swap: boolean
    history: boolean
    sponsorship: boolean
  }
  status: 'available' | 'maintenance' | 'disabled' | 'coming_soon'
  riskNotice?: string
  sortOrder: number
}
```

The frontend validates this response with a strict schema. Unknown families/adapters render as unsupported and cannot be provisioned. URLs are generated only from validated trusted templates; never accept executable JavaScript or arbitrary HTML from catalogue data.

### Frontend adapter registry

```ts
type WalletFamilyAdapter = {
  family: string
  algorithms: readonly string[]
  generateAccount(): Promise<GeneratedAccount>
  derivePublicMetadata(secret: Uint8Array): Promise<PublicAccountMetadata>
  validateAddress(address: string, network: NetworkDescriptor): boolean
  signIntent(input: SignIntentInput): Promise<SignedPayload>
  verifyIntentBinding(input: VerifyIntentInput): Promise<void>
  wipe(secret: Uint8Array): void
}
```

Register adapters in one explicit map. UI code never uses a chain-family `if/else` tree to generate keys or sign. Adding a network in an existing family requires catalogue/config work only; adding a family requires a reviewed adapter and test suite.

### Registry responsibilities

One normalized selector layer drives:

- Network picker and grouping.
- Icons/names/native decimals.
- Account reuse versus new-family provisioning.
- Address validation.
- Explorer links.
- Balance and transaction capabilities.
- Signing-adapter choice.
- Disabled/maintenance/coming-soon states.
- Feature flags and rollout cohorts.

Do not maintain separate hard-coded maps for explorer names, chain IDs, family display names, or enabled networks.

---

## 11. Network onboarding state machine

```text
idle
  -> selecting-network
  -> checking-existing-family
       -> existing-family: prepare-public-binding
       -> new-family: require-unlock -> generate -> encrypt -> journal
  -> request-ownership-challenge
  -> sign-challenge-locally
  -> register-public-account-or-binding
  -> activate-local-binding
  -> refresh-balances
  -> complete

Any step -> recoverable-failure -> resume same operationId
```

### Case A: network uses an existing family account

Example: user has Ethereum/EVM and adds Arbitrum.

1. Fetch the latest catalogue.
2. Locate the active `evm` account in the encrypted package.
3. Do not generate or decrypt a new private key merely to display the address.
4. Create a pending `NetworkBinding` using the same canonical EVM address.
5. Request a one-time backend ownership challenge for the account/network.
6. If fresh signing confirmation is required, unlock with PIN or passphrase.
7. Decrypt the existing EVM key only long enough to sign the challenge.
8. Register the public network binding idempotently using `operationId`.
9. Mark the local binding active and refresh balances.

### Case B: network introduces a new chain family

1. Fetch and validate the latest catalogue descriptor.
2. Resolve its family adapter.
3. Create a durable operation journal with a random stable `operationId`.
4. Require passphrase or PIN unlock of the existing DEK.
5. Generate one new account locally.
6. Encrypt the new private key immediately with the existing DEK and account-specific AAD.
7. Wipe the generated plaintext secret in `finally`.
8. Persist the encrypted account as `pending-registration` before calling the backend.
9. Request a backend ownership challenge.
10. Decrypt/sign the challenge locally and wipe the key again.
11. Send only public key, address, family, algorithm, network ID, challenge ID, signature, and operation ID.
12. On success, atomically mark the binding active.
13. On timeout/unknown backend result, query operation/account status before retrying. Never generate another key.

### Case C: backend enables another network automatically

Do not silently add it to every user's wallet. Show it as “Available to add.” Automatic binding may be offered only when product explicitly approves it and no new key/consent/risk notice is required.

### Case D: network is disabled or under maintenance

- Keep the encrypted account and address.
- Mark the network binding unavailable; never delete keys automatically.
- Disable new signing/submission.
- Preserve history and receive/address visibility with a clear notice.
- Re-enable without regenerating the account.

---

## 12. Ownership proof contract

Frontend dependencies on the backend:

```text
GET  /v1/networks
GET  /v1/wallets/me
POST /v1/wallets/me/accounts/challenge
POST /v1/wallets/me/accounts
GET  /v1/wallets/me/accounts
```

Challenge response:

```ts
type OwnershipChallenge = {
  challengeId: string
  operationId: string
  walletId: string
  accountId: string
  family: string
  networkId: string
  publicKey: string
  address: string
  nonce: string
  statement: string
  issuedAt: string
  expiresAt: string
}
```

The backend must build the canonical statement. The frontend displays its purpose, signs the exact bytes with the corresponding local account, and submits:

```ts
type RegisterPublicAccountRequest = {
  challengeId: string
  operationId: string
  family: string
  algorithm: string
  networkId: string
  publicKey: string
  address: string
  signature: string
}
```

The request must reject unknown fields so a private key or passphrase cannot be accidentally serialized. Use an explicit DTO constructed field-by-field; never spread wallet/account objects into API requests.

---

## 13. Frontend module structure

```text
src/wallet/
├── crypto/
│   ├── aes-gcm.ts
│   ├── argon2id.ts
│   ├── random.ts
│   ├── encoding.ts
│   ├── aad.ts
│   ├── envelope.ts
│   └── wipe.ts
├── package/
│   ├── schema.ts
│   ├── canonicalize.ts
│   ├── repository.ts
│   ├── migrate.ts
│   ├── backup.ts
│   └── revision-lock.ts
├── unlock/
│   ├── session.ts
│   ├── passphrase.ts
│   ├── device-key.ts
│   ├── pin.ts
│   ├── policy.ts
│   └── cross-tab-lock.ts
├── families/
│   ├── registry.ts
│   ├── types.ts
│   ├── evm.ts
│   ├── solana.ts
│   └── future/
├── networks/
│   ├── catalogue-schema.ts
│   ├── catalogue-query.ts
│   ├── selectors.ts
│   ├── provisioning-machine.ts
│   └── operation-journal.ts
├── signing/
│   ├── policy.ts
│   ├── intent-binding.ts
│   ├── signer.ts
│   └── confirmation.ts
├── api/
│   ├── wallet-client.ts
│   └── explicit-dtos.ts
└── ui/
    ├── WalletSetupFlow.tsx
    ├── WalletUnlockDialog.tsx
    ├── PinEnrollmentFlow.tsx
    ├── AddNetworkFlow.tsx
    ├── NetworkStatus.tsx
    └── SigningReviewDialog.tsx
```

Cryptographic modules must not import React. UI modules call narrow wallet-service methods and never manipulate secret byte arrays.

---

## 14. UI/UX requirements

### Wallet setup

1. Explain self-custody and that TsionMarket cannot reset the wallet passphrase.
2. Collect and confirm a 12+ character passphrase.
3. Show strength guidance without arbitrary composition rules.
4. Generate and encrypt the initial wallet locally.
5. Register public ownership.
6. Offer encrypted-backup download.
7. Offer optional PIN enrollment after passphrase setup succeeds.

### Unlock dialog

- Default to PIN when a device PIN exists.
- Always expose “Use passphrase instead.”
- Explain that PIN is device-specific.
- Show remaining local attempts generically without revealing cryptographic details.
- After lockout, require passphrase; do not offer server reset of wallet encryption.
- Never navigate users away from the transaction they were attempting; resume the exact pending action after successful unlock.

### Add-network flow

- Group networks by status and family.
- Show whether adding the network reuses an existing address or creates a new family account.
- Show native asset, capabilities, mainnet/testnet badge, risk notice, and explorer.
- Add exactly the selected network, not every missing network.
- Use a visible staged progress UI: preparing, securing key if needed, proving ownership, registering, refreshing balances.
- On failure, show “Resume setup” using the existing operation journal.
- Never show a successful state until both local persistence and backend public registration are confirmed.

### Signing review

Show exact action, network, asset, amount, recipient/contract, estimated fee, allowance if any, slippage, and risk warning. PIN/passphrase confirmation belongs in this dialog so the user returns to the same intent afterward.

---

## 15. Implementation phases

## Frontend Phase 3.0 — Contract and crypto review

- Finalize package/AAD schemas and backend ownership challenge bytes.
- Select and benchmark the browser Argon2id implementation.
- Define supported browsers and secure-context requirements.
- Complete a focused cryptographic design review before coding UI.

**Exit:** Fixed test vectors and approved package format exist.

## Frontend Phase 3.1 — Crypto primitives

- Implement random, encoding, AES-GCM, Argon2id, AAD, wrap/unwrap, and wipe helpers.
- Enforce parameter bounds before running KDF/decryption.
- Add deterministic vectors and negative tamper tests.

**Exit:** DEK/account/passphrase round trips and tamper rejection pass.

## Frontend Phase 3.2 — IndexedDB package repository

- Implement schema, validation, revisions, transactions, operation journal, migration framework, and cross-tab locking.
- Add encrypted backup export/import staging.

**Exit:** Crash/reload/concurrent-tab tests cannot corrupt or roll back a package revision.

## Frontend Phase 3.3 — Initial wallet provisioning

- Generate the initial required family account(s) locally.
- Encrypt immediately under one DEK.
- Wrap DEK with the passphrase envelope.
- Persist before public registration.
- Prove/register public ownership idempotently.

**Exit:** Setup interruption resumes without address changes or duplicate keys.

## Frontend Phase 3.4 — Unlock service

- Implement passphrase unwrap and memory-only session.
- Implement idle/absolute expiry, manual lock, logout/user-switch lock, and cross-tab lock.
- Prevent locking mid-signature using a bounded in-flight operation guard.

**Exit:** DEK never appears in persistent storage or React state; expiry/manual lock wipe it.

## Frontend Phase 3.5 — Device PIN

- Generate/store non-exportable device key.
- Create nested PIN envelope only after passphrase unlock.
- Implement PIN unlock, delay/lockout, forgot-PIN deletion, and passphrase fallback.
- Exclude PIN envelope/device key from portable backups.

**Exit:** PIN unlock reaches the same DEK/accounts; copied portable package cannot be PIN-unlocked on another device.

## Frontend Phase 3.6 — Local signing

- Implement family adapter registry.
- Verify backend intent binding before signing.
- Require a fresh PIN/passphrase confirmation according to policy.
- Decrypt one account key, sign, and wipe in `finally`.

**Exit:** Both PIN and passphrase can authorize the same exact-intent signing flow; mutated intents fail.

## Frontend Phase 3.7 — Network catalogue

- Implement strict descriptor schema, query/cache, registry selectors, status/risk UI, and adapter resolution.
- Remove scattered hard-coded network/explorer/family maps.

**Exit:** Adding a supported network descriptor requires no screen-level code changes.

## Frontend Phase 3.8 — Resumable network onboarding

- Implement existing-family binding and new-family provisioning branches.
- Persist stable operation IDs and pending encrypted accounts before network calls.
- Reconcile unknown results instead of regenerating.

**Exit:** Every retry preserves the same account/address and converges to one backend registration.

## Frontend Phase 3.9 — Recovery and backup

- Validate/import encrypted backup.
- Unlock with passphrase before activation.
- Recompute public metadata and compare it with package/backend state.
- Enroll a new device PIN after restore.

**Exit:** Clean-browser restore reproduces identical public addresses without backend secrets.

## Frontend Phase 3.10 — Rollout

- Feature flags: wallet setup, PIN unlock, per-family adapters, per-network onboarding.
- Internal accounts, opt-in cohort, testnet soak, limited production cohort, then broader rollout.
- Keep passphrase unlock available throughout.

**Exit:** Monitoring and security signoff approve default-on rollout.

---

## 16. Testing requirements

### Cryptographic unit tests

- DEK length/randomness contract.
- AES-GCM encrypt/decrypt round trip.
- Unique IV generation.
- AAD/ciphertext/IV tampering rejection.
- Wrong passphrase/PIN rejection.
- KDF lower/upper-bound validation.
- Fixed package/AAD vectors.
- Package-version rejection/migration.
- Key/address recomputation after decrypt.
- Buffer wiping paths on success, error, and cancellation.

### PIN tests

- Enrollment requires passphrase unlock.
- Correct PIN unwraps the same DEK.
- Wrong PIN never mutates the package.
- Attempt delays/lockout.
- Forgot PIN deletes only local PIN data.
- PIN envelope copied without the device key is unusable.
- Backup restore requires passphrase and allows new PIN enrollment.

### Provisioning tests

- Initial wallet setup.
- Existing EVM account + new EVM network reuses address.
- New family generates exactly one account.
- Refresh/crash after local encryption but before backend registration.
- Timeout after backend accepted registration.
- Double click/two tabs.
- Stale package revision.
- Backend network disabled during setup.
- Unsupported adapter/catalogue version.
- Registration challenge expired/replayed/mismatched.
- User cancels without losing existing accounts.

### Signing tests

- Passphrase-authorized signing.
- PIN-authorized signing.
- Expired confirmation opens unlock and resumes exact action.
- From-address/network/chain/amount/destination/calldata/fee mutation rejection.
- Wrong-family key rejection.
- Intent expiry/double-submit behavior.
- Plaintext key lifetime instrumentation.

### Browser matrix

- Current Chrome/Edge desktop.
- Current Safari macOS/iOS.
- Current Chrome Android.
- Private browsing/storage denial behavior.
- IndexedDB quota/storage eviction behavior.
- Web Worker and non-exportable CryptoKey persistence behavior per supported browser.

---

## 17. Telemetry and redaction

Allowed events:

- Setup stage and duration.
- KDF duration/profile version without passphrase/PIN.
- Unlock method and success/failure category.
- Lock reason.
- Network onboarding stage/error code.
- Adapter/network ID and package version.

Forbidden telemetry:

- Passphrase/PIN or length beyond coarse policy result.
- DEK, private key, seed, recovery secret.
- Raw encrypted package/ciphertext.
- Raw ownership challenge/signature or signed transaction.
- Clipboard content.

Scrub error objects before analytics or crash reporting.

---

## 18. Release gates

- Cryptographic package format reviewed independently.
- Argon2id dependency and WASM delivery/CSP reviewed.
- KDF benchmark complete on lowest supported mobile device.
- No secret reaches network mocks, logs, analytics, React Query cache, or persistent plaintext storage.
- Ownership-proof canonical bytes agreed with backend and covered by shared vectors.
- Existing-family network addition demonstrably reuses the same address.
- Interrupted new-family setup resumes the same generated account.
- PIN wrapper is device-bound and excluded from backup.
- Passphrase can recover after PIN deletion/lockout/new device.
- All signing mutation tests pass.
- Testnet soak and external security review complete before meaningful funds.

---

## 19. Definition of done

Phase 3 frontend work is complete when a new authenticated user can:

1. Choose and confirm a passphrase of at least 12 characters.
2. Generate wallet keys locally and persist only an encrypted package.
3. Register public ownership without sending secret material.
4. Unlock with the passphrase.
5. Enroll a device PIN without changing the wallet or addresses.
6. Unlock and sign a reviewed transaction using either PIN or passphrase.
7. Manually lock and immediately wipe in-memory DEK state.
8. Add a new network in an existing family without generating a new private key.
9. Add a new chain family once, safely resume failures, and never duplicate its account on retry.
10. Export an encrypted backup and restore identical addresses on a clean browser using the passphrase.

At no point may the frontend send the passphrase, PIN, DEK, private key, seed, or recovery secret to the TsionMarket backend.
