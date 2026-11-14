# Secretos Cloudflare — Enterprise Diagnostic

No pegues valores de secretos en chat ni en el repo.

## Obligatorios para firma HMAC del paquete de evidencia

| Secreto | Dónde | Uso |
|---------|--------|-----|
| `PII_HMAC_SECRET` | Worker → Settings → Variables and Secrets | Firma HMAC-SHA256 del evidence package (≥16 caracteres aleatorios) |
| `API_KEY` | Alternativa si no hay `PII_HMAC_SECRET` | También se usa como material de firma |

Recomendación: configurá **ambos**; la firma usa `PII_HMAC_SECRET` o, si falta, `API_KEY`.

## R2 (guardar el paquete)

Bindings (no secretos de texto, sino R2 bucket binding en wrangler / dashboard):

| Binding | Uso |
|---------|-----|
| `AUDIT_ARCHIVE` | Preferido para evidencia de diagnóstico |
| `JOURNAL` | Fallback si no hay `AUDIT_ARCHIVE` |

Sin ninguno: `stored: false` y `delivery` no será `stored_only`.

## Email (opcional hasta que integres proveedor)

El código reconoce intención de mail si existen (nombres reservados para integración):

| Secreto / var | Uso |
|---------------|-----|
| `RESEND_API_KEY` | Envío transaccional (cuando se implemente el sender) |
| `MAIL_FROM` | Remitente verificado |

Hoy, sin provider real: `delivery: "email_skipped_no_provider"` o `"stored_only"` si R2 funcionó.

## GitHub Actions (OTS / R2 audit anchor — aparte del diagnóstico Shopify)

| Secreto Actions | Uso |
|-----------------|-----|
| `ASTON_R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `ASTON_AUDIT_R2_BUCKET` | Nombre del bucket |
| `ASTON_R2_ACCESS_KEY_ID` | R2 access key (formato R2, no confundir longitud) |
| `ASTON_R2_SECRET_ACCESS_KEY` | R2 secret |
| `ASTON_OTS_BITCOIN_NODE` | Opcional para upgrade OTS |

## Staging

| Secreto | Uso |
|---------|-----|
| `AUDIT_SECRET` | Endpoint de auditoría staging (≥32 chars) |

## OpenSSF

Badge de proceso ATI: https://www.bestpractices.dev/projects/16476  
No certifica el dominio escaneado del cliente.
