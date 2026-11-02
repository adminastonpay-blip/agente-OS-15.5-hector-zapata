/**
 * Certified Extraction Engine — types
 * Aston OS 15.5 · Hector Zapata
 */

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "duration"
  | "integer"
  | "list"
  | "estimate"
  | "forecast";

export interface FieldSchema {
  name: string;
  type: FieldType;
  description?: string;
  /** Minimum confidence to auto-certify (0-1). Default 0.9 */
  min_confidence?: number;
  /** Maximum p_null to auto-certify (0-1). Default 0.15 */
  max_p_null?: number;
}

export interface ExtractedField {
  name: string;
  type: FieldType;
  value: unknown;
  confidence: number;
  p_null: number;
  certified: boolean;
  reviewed_by?: string;
  p10?: number;
  p90?: number;
  median?: number;
}

export interface ExtractionCertificate {
  certificate_id: string;
  object_id: string;
  schema_version: string;
  model: "@cf/cloudflare/clairic";
  input_hash: string;
  fields: ExtractedField[];
  extracted_by: string;
  extracted_at: number;
  tenant: string;
  document_id?: string;
  /** Base64 ML-DSA signature over the canonical payload */
  signature: string;
}

export interface ExtractionPayload {
  documentId: string;
  tenant: string;
  actor: string;
  rawText?: string;
  images?: string[];
  schema: FieldSchema[];
  schema_version?: string;
  thresholds?: {
    min_confidence?: number;
    max_p_null?: number;
  };
}

export interface ClairicResult {
  fields: Array<{
    name: string;
    value: unknown;
    confidence: number;
    p_null: number;
    p10?: number;
    p90?: number;
    median?: number;
  }>;
}
