# ASTON VBC-2030 Shopify UI assets

This directory contains portable Shopify theme assets. It is not a Shopify theme repository and these files are not installed in a live store.

## Installation boundary

Copy `sections/aston-vbc-dashboard.liquid` into the target Shopify theme's `sections/` directory only after reviewing it in a theme preview.

The dashboard defaults to a clearly labeled visual simulation. It does not execute ARP-100 tests. The certificate request uses a Shopify App Proxy path so no Worker secret is exposed in browser JavaScript. A server-side App Proxy implementation is required before it can issue a certificate.

Do not put `AUDIT_SECRET`, signing keys, Cloudflare API tokens, or R2 credentials in Liquid settings or browser code.
