# ASTON OS — Agent Economy wedge (Micro-SaaS factory)

## Live endpoints

| Method | Path | Purpose |
|--------|------|--------|
| POST | `/v1/factory/generate` | Describe a business problem → micro-tool + recipe |
| GET | `/v1/factory/tools` | List tools for tenant |
| GET | `/v1/factory/tools/:id` | Get one tool |
| POST | `/v1/factory/run` | Execute allowlisted recipe |
| POST | `/v1/factory/simulate` | Pre-deploy risk notes via SimulationTwin |

## Example

```bash
curl -X POST https://agente-os-15-5-hector-zapata.adminastonpay.workers.dev/v1/factory/generate \
  -H "Content-Type: application/json" \
  -d '{"problem":"Cruzar inventario con clima para predecir mermas"}'

curl -X POST https://agente-os-15-5-hector-zapata.adminastonpay.workers.dev/v1/factory/run \
  -H "Content-Type: application/json" \
  -d '{"tool_id":"YOUR_ID","input":{"producto":"leche","stock":120}}'
```

## Security stance

- **No unrestricted `eval`** of model-generated code in the main isolate.
- Recipes use allowlisted ops: `echo`, `json_pick`, `template`, `ai_reason`, `math`, `merge`.
- `code_preview` is stored for future **Dynamic Workers** deploy with `globalOutbound: null`.
- `wallet_hint` is a placeholder until Cloudflare Wallets / metering is bound.

## Next platform steps

1. Dynamic Workers dispatch to run `code_preview` for real.
2. Workers for Platforms isolation per customer tool.
3. Wallets micropayments agent→agent.
4. Containers for Python-heavy sandboxes.
