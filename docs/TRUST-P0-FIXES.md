# Trust P0 fixes (branch trust/decision-passport-v0)

| Issue | Fix |
|-------|-----|
| Public tenant spoofing via `X-Aston-Tenant` | Public identity always `tenant=default`; header ignored |
| `/v1/validate` always true | Requires API key; returns `production_ready: false` stub |
| Ephemeral certificate keys | HMAC Decision Passport with `PII_HMAC_SECRET` or `API_KEY` |
| Independent verify | `POST /v1/trust/verify` |
| Version drift | `package.json` → `21.6.4` |
| No tests | `npm test` → `tests/trust-isolation.test.mjs` |

## Secrets to set in Cloudflare

```
PII_HMAC_SECRET=<long random string>
API_KEY=<admin api key>
```

Without these, passports are not issued (explicit `trust_note`).

## Do not merge to main until

- [ ] `npm test` passes
- [ ] Manual check: public cannot set foreign tenant
- [ ] Manual check: verify passport round-trip
