/**
 * Certified Extraction Workflow
 * Clairic → partition → human review (if needed) → ML-DSA certificate → journal
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import type { Env, Identity } from "../types";
import type { ExtractionPayload, ExtractedField } from "../extraction/types";
import { runClairic, partitionFields, hashInput } from "../extraction/clairic";
import { buildAndSignCertificate } from "../extraction/certificate";
import { createObject } from "../ontology";

export class CertifiedExtractionWorkflow extends WorkflowEntrypoint<
  Env,
  ExtractionPayload
> {
  async run(event: WorkflowEvent<ExtractionPayload>, step: WorkflowStep) {
    const p = event.payload;
    const extractionIdentity: Identity = {
      actor: p.actor,
      method: "apikey",
      tenant: p.tenant,
      roles: ["executor"],
      clearance: "confidential",
    };
    if (!extractionIdentity.actor?.trim() || !extractionIdentity.tenant?.trim()) {
      throw new Error("verified_extraction_identity_required");
    }

    const inputHash = await step.do("hash-input", async () => {
      return hashInput(p.rawText ?? "", p.images ?? []);
    });

    const extraction = await (step.do as any)(
      "clairic-extract",
      {
        retries: { limit: 2, delay: "5 seconds" },
        timeout: "60 seconds",
      },
      async () => {
        return runClairic(this.env, extractionIdentity, {
          text: p.rawText,
          images: p.images,
          schema: p.schema,
        });
      }
    ) as import("../extraction/types").ClairicResult;

    const { certified, needsReview } = partitionFields(
      extraction,
      p.schema,
      p.thresholds
    );

    let allFields: ExtractedField[] = [...certified];

    if (needsReview.length > 0) {
      let approval: {
        corrections: Record<string, unknown>;
        reviewer: string;
      };

      try {
        const received = await (step.waitForEvent as any)(
          "await-human-review",
          { type: "extraction.reviewed", timeout: "24 hours" }
        ) as { payload: { corrections: Record<string, unknown>; reviewer: string } };
        approval = received.payload;
      } catch {
        approval = { corrections: {}, reviewer: "timeout-auto-reject" };
      }

      for (const field of needsReview) {
        if (approval.corrections[field.name] !== undefined) {
          field.value = approval.corrections[field.name];
          field.confidence = 1.0;
          field.p_null = 0;
          field.certified = true;
          field.reviewed_by = approval.reviewer;
          allFields.push(field);
        } else {
          allFields.push(field);
        }
      }
    }

    const certificate = await (step.do as any)("certify-and-persist", async () => {
      const identity = {
        actor: p.actor,
        method: "apikey" as const,
        tenant: p.tenant,
        roles: ["executor"],
        clearance: "confidential" as const,
      };

      const properties: Record<string, unknown> = {};
      for (const f of allFields.filter((x) => x.certified)) {
        properties[f.name] = f.value;
        properties[`${f.name}__confidence`] = f.confidence;
        properties[`${f.name}__p_null`] = f.p_null;
      }
      properties.__document_id = p.documentId;
      properties.__input_hash = inputHash;
      properties.__certified = true;

      // A certificate must never point at a synthetic ID for an object that failed to persist.
      // Let the workflow fail and retry/raise an operator-visible error instead.
      const objectId = await createObject(this.env, identity, {
        type_id: "ot_certified_extraction",
        properties,
      });

      return buildAndSignCertificate(this.env, {
        fields: allFields,
        inputHash,
        actor: p.actor,
        tenant: p.tenant,
        documentId: p.documentId,
        schemaVersion: p.schema_version ?? "v1",
        objectId,
      });
    }) as import("../extraction/types").ExtractionCertificate;

    return {
      documentId: p.documentId,
      certificate_id: certificate.certificate_id,
      object_id: certificate.object_id,
      certified_count: allFields.filter((f) => f.certified).length,
      total_count: allFields.length,
      needs_review_remaining: allFields.filter((f) => !f.certified).length,
    };
  }
}
