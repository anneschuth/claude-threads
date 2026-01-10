/**
 * Type declarations for @redactpii/node
 *
 * @redactpii/node is a zero-dependency PII redaction library.
 * https://www.npmjs.com/package/@redactpii/node
 */

declare module '@redactpii/node' {
  export interface RedactorOptions {
    /** API key for dashboard integration (optional) */
    apiKey?: string;
    /** Custom API URL for dashboard (optional) */
    apiUrl?: string;
    /** Whether to fail silently on errors (default: true) */
    failSilent?: boolean;
    /** Timeout for dashboard hook in ms (default: 500) */
    hookTimeout?: number;
    /** Rule configuration - which rules to enable/disable */
    rules?: {
      CREDIT_CARD?: boolean;
      EMAIL?: boolean;
      NAME?: boolean;
      PHONE?: boolean;
      SSN?: boolean;
    };
    /** Custom rules to add */
    customRules?: Array<{
      pattern: RegExp;
      name: string;
      replaceWith?: string;
    }>;
    /** Global replacement string for all rules */
    globalReplaceWith?: string;
    /** Enable anonymization mode (use consistent tokens) */
    anonymize?: boolean;
    /** Enable aggressive mode for catching obfuscated patterns */
    aggressive?: boolean;
  }

  export class Redactor {
    constructor(options?: RedactorOptions);

    /**
     * Redact PII from text
     * @param text - The text to redact
     * @returns The redacted text with PII replaced by labels
     */
    redact(text: string): string;
  }
}
