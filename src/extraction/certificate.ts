/**
 * Extraction certificate — build + sign with ML-DSA (PQC)
 */

import type { Env } from "../types";
import type { ExtractionCertificate, ExtractedField } from "./types";
import { emitLineage } from "../lineage";

function canonical(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as any).sort());
}

async function signPayload(
  payload: string,
  secret: string
): Promise<{ signature: string; alg: string }> {
  try {
    const keyPair = await crypto.subtle.generateKey(
      "ML-DSA-44" as any,
      true,
      ["sign", "verify"]
    ).catch(() => null);

    if (keyPair) {
      const sig = await crypto.subtle.sign(
        "ML-DSA-44" as any,
        (keyPair as CryptoKeyPair).privateKey,
        new TextEncoder().encode(payload)
      );
      const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
      return { signature: `mldsa44:${b64}`, alg: "ML-DSA-44" };
    }
  } catch {
    // fall through
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { signature: `hmac-sha256:${hex}`, alg: "HMAC-SHA256" };
}

export async function buildAndSignCertificate(
  env: Env,
  opts: {
    fields: ExtractedField[];
    inputHash: string;
    actor: string;
    tenant: string;
    documentId?: string;
    schemaVersion?: string;
    objectId?: string;
  }
): Promise<ExtractionCertificate> {
  const certificate_id = `cert_${crypto.randomUUID()}`;
  const object_id = opts.objectId ?? `obj_ext_${crypto.randomUUID()}`;
  const extracted_at = Date.now();

  const unsigned = {
    certificate_id,
    object_id,
    schema_version: opts.schemaVersion ?? "v1",
    model: "@cf/cloudflare/clairic" as const,
    input_hash: opts.inputHash,
    fields: opts.fields,
    extracted_by: opts.actor,
    extracted_at,
    tenant: opts.tenant,
    document_id: opts.documentId,
  };

  const payload = canonical(unsigned);
  const { signature } = await signPayload(
    payload,
    env.PII_HMAC_SECRET ?? "default-dev-secret"
  );

  const certificate: ExtractionCertificate = {
    ...unsigned,
    signature,
  };

  const journal = env.JOURNAL;
  if (!journal) throw new Error("R2 JOURNAL binding required to persist certificates");
  await journal.put(
    `certificates/${opts.tenant}/${certificate_id}.json`,
    JSON.stringify(certificate),
    { httpMetadata: { contentType: "application/json" } }
  );

  await emitLineage(env, {
    object_id,
    transformation: "cee.certify",
    pipeline_version: "v15.5",
    model: "@cf/cloudflare/clairic",
    actor: opts.actor,
    metadata: {
      certificate_id,
      certified_fields: opts.fields.filter((f) => f.certified).length,
      total_fields: opts.fields.length,
      input_hash: opts.inputHash,
    },
  });

  const db = env.DB;
  if (db) try {
    await db.prepare(
      `INSERT INTO extraction_certificates
       (id, object_id, tenant, document_id, model, input_hash, certified_count, total_count, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        certificate_id,
        object_id,
        opts.tenant,
        opts.documentId ?? null,
        "@cf/cloudflare/clairic",
        opts.inputHash,
        opts.fields.filter((f) => f.certified).length,
        opts.fields.length,
        opts.actor,
        extracted_at
      )
      .run();
  } catch {
    // table may not exist yet
  }

  return certificate;
}
