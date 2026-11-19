/**
 * Clairic extraction + field partitioning
 */

import type { Env, Identity } from "../types";
import { ControlGate } from "../core/control-gate";
import { ModelRunner } from "../core/model-runner";
import type { FieldSchema, ExtractedField, ClairicResult } from "./types";

const DEFAULT_MIN_CONF = 0.9;
const DEFAULT_MAX_PNULL = 0.15;

export async function runClairic(
  env: Env,
  identity: Identity,
  opts: {
    text?: string;
    images?: string[];
    schema: FieldSchema[];
  }
): Promise<ClairicResult> {
  const schemaPayload = Object.fromEntries(
    opts.schema.map((f) => [f.name, { type: f.type, description: f.description ?? "" }])
  );

  const model = "@cf/cloudflare/clairic";
  const payload = {
    state: {
      text: opts.text ?? "",
      images: opts.images ?? [],
    },
    schema: schemaPayload,
    options: { include_quantiles: true },
  };
  try {
    const gate = await new ControlGate(env).authorizeInference(identity, "extraction", payload, model);
    if (!gate.ok) throw new Error(gate.reason);
    const res = await new ModelRunner(env).execute<any>(
      gate.permit,
      "extraction",
      model,
      payload,
      Boolean(env.AI_GATEWAY_ID)
    );

    const fields = (res.fields ?? res.data ?? []).map((f: any) => ({
      name: f.name,
      value: f.value ?? f.prediction ?? null,
      confidence: Number(f.confidence ?? f.score ?? 0),
      p_null: Number(f.p_null ?? f.null_probability ?? 0),
      p10: f.p10,
      p90: f.p90,
      median: f.median,
    }));

    return { fields };
  } catch (e) {
    console.error("Clairic call failed:", e);
    return {
      fields: opts.schema.map((s) => ({
        name: s.name,
        value: null,
        confidence: 0,
        p_null: 1,
      })),
    };
  }
}

export function partitionFields(
  clairic: ClairicResult,
  schema: FieldSchema[],
  globalThresholds?: { min_confidence?: number; max_p_null?: number }
): { certified: ExtractedField[]; needsReview: ExtractedField[] } {
  const schemaMap = new Map(schema.map((s) => [s.name, s]));
  const certified: ExtractedField[] = [];
  const needsReview: ExtractedField[] = [];

  for (const f of clairic.fields) {
    const sch = schemaMap.get(f.name);
    const minConf = sch?.min_confidence ?? globalThresholds?.min_confidence ?? DEFAULT_MIN_CONF;
    const maxPNull = sch?.max_p_null ?? globalThresholds?.max_p_null ?? DEFAULT_MAX_PNULL;

    const field: ExtractedField = {
      name: f.name,
      type: (sch?.type ?? "text") as any,
      value: f.value,
      confidence: f.confidence,
      p_null: f.p_null,
      certified: false,
      p10: f.p10,
      p90: f.p90,
      median: f.median,
    };

    const ok =
      f.value !== null &&
      f.value !== undefined &&
      f.confidence >= minConf &&
      f.p_null <= maxPNull;

    if (ok) {
      field.certified = true;
      certified.push(field);
    } else {
      needsReview.push(field);
    }
  }

  return { certified, needsReview };
}

export async function hashInput(text: string, images: string[] = []): Promise<string> {
  const payload = JSON.stringify({ text, images });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
