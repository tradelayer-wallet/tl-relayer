# tl-relayer Agent Notes

This repo now acts as the balance/watch-only relay layer for TL-Web.
The server agent should keep the following behavior intact:

## Purpose

- Accept `address + pubkey` pairs from the browser wallet.
- Import those pubkeys as watch-only on the configured RPC backend.
- Serve address UTXO and token balance lookups back to the browser wallet.
- Prefer routing watch-only imports and balance reads through `tl-collator` when configured.

## Current contract

- `POST /address/sync-watchonly`
  - Body: `{ accounts: [{ address: string, pubkey: string }] }`
  - Purpose: batch-import watch-only pubkeys before balance polling.
- `POST /address/utxo/:address`
  - Body may include `{ pubkey }`.
- `GET /address/balance/:address`
- `GET /address/validate/:address`
- `GET /address/watchonly`
  - Returns the canonical watch-only registry.
- `GET /address/watchonly/:address`
  - Returns the registry entry for one address.
- `POST /address/watchonly/snapshot`
  - Body: `{ network?, address, pubkey?, utxos: [...] }`
  - Purpose: store the latest UTXO-set snapshot for an imported watch-only address.

## Registry rules

- `tl-relayer` is the source of truth for watch-only keys.
- Every imported `{ address, pubkey }` pair should be upserted into the registry.
- The relayer should fall back to the registry pubkey if a later UTXO poll omits one.
- UTXO polling should record a snapshot hash so redundant imports and drift can be detected.
- The registry is persisted to `TL_RELAYER_STATE_DIR` / `RELAYER_STATE_DIR` or `state/watchonly-registry.json` by default.

## Collator-backed mode

When `TL_COLLATOR_URL` is set:

- `address.service.ts` must route RPC calls through:
  - `POST ${TL_COLLATOR_URL}/rpc/route`
- The relayer must pass:
  - `service = TL_COLLATOR_RPC_SERVICE` or `tradelayer.rpc`
  - `network = TL_COLLATOR_RPC_NETWORK` or the current chain network
- This is the preferred mode for watch-only import and UTXO discovery.

When `TL_COLLATOR_URL` is not set:

- Fall back to the direct local RPC backend configured by:
  - `RPC_HOST`
  - `RPC_PORT`
  - `RPC_USER`
  - `RPC_PASS`

## Files that matter

- `src/services/address.service.ts`
- `src/services/sochain.service.ts`
- `src/config/env.config.ts`
- `src/config/rpc.config.ts`
- `src/routes/address.route.ts`
- `src/routes/rpc.route.ts`
- `src/routes/routes.ts`

## Important constraints

- Do not hardcode localhost-only watch-only behavior if a collator URL is present.
- Do not remove the direct-RPC fallback, because some deployments still depend on it.
- Keep the watch-only import idempotent. Repeated browser balance polls should not spam imports.
- The server agent should treat `rpcProviders` on `tl-collator` as the source of truth for routed RPC availability.
- The server agent should use `/address/watchonly` as the canonical registry view when reconciling wallet balances.

## Verification

- `npx webpack --mode=development` should build successfully in this repo.
- If a package script fails because of `NODE_OPTIONS=--openssl-legacy-provider`, run the build with `NODE_OPTIONS` cleared and use the local webpack binary directly.
