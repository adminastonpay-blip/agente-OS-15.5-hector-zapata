/** Narrow output leak guard for obvious credential and private-key material. */
const SENSITIVE_OUTPUT_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
];

/**
 * Returns false only for obvious secret-like output.
 * This is not semantic moderation, DLP, or prompt-injection detection.
 */
export function isOutputSafeForCredentialLeak(answer: string): boolean {
  return !SENSITIVE_OUTPUT_PATTERNS.some((pattern) => pattern.test(answer));
}
