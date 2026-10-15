/address/validate/:address - validateaddress 
/address/balance/:address - tl_getallbalancesforaddress
/address/watchonly - canonical watch-only registry
/address/watchonly/:address - one registry entry
/address/watchonly/snapshot - store latest UTXO snapshot

/tx/:txid - tl_gettransaction

/token/list - tl_listproperties
/token/:propid - tl_getproperty

## Fixed limits (not env-configurable)

These bounds are enforced in code, so a request that exceeds one is refused without reaching a route handler.

| Limit | Value | Where |
| --- | --- | --- |
| HTTP request headers | 10 s from connection start (and from the end of each response) | `src/services/http-deadlines.service.ts` |
| HTTP request body | 30 s from headers complete until the body ends | `src/services/http-deadlines.service.ts` |
| Idle keep-alive socket | 60 s after a response finishes | `src/services/http-deadlines.service.ts` |
| HTTP body size | 1 MiB | `REQUEST_BODY_LIMIT_BYTES` in `src/services/security-utils.service.ts` (Fastify `bodyLimit`) |
| WebSocket frame size | 1 MiB; a larger frame closes with 1009 | `REQUEST_BODY_LIMIT_BYTES` in `src/services/security-utils.service.ts` (used by `src/services/ws-relay.service.ts`) |
| Reputation provider response | 1 MiB; redirects are not followed | `src/services/attestation.service.ts` |
| chain.so UTXO page response | 4 MiB; redirects are not followed | `src/services/watchonly-external.service.ts` |
| Bootstrap seed response | 32 MiB; redirects are not followed | `src/services/watchonly-registry.service.ts` |

Operators who need a larger bootstrap seed or a larger WebSocket frame change the constant in the file named above, after review.
