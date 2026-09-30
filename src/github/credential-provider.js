import { redact } from '../credentials/redact.js';

/**
 * Origin-independent interface. The composition root supplies loadCredentials()
 * from the credential store; this module never reads a file or environment token.
 * @typedef {{ getToken: () => Promise<string> }} CredentialProvider
 * @typedef {{ getToken: () => string | Promise<string> }} CredentialSource
 */

/**
 * Expose only the getter, preserving the source's receiver and hiding its metadata.
 * @param {CredentialSource} source
 * @returns {Readonly<CredentialProvider>}
 */
export function createCredentialProvider(source) {
  return Object.freeze({
    async getToken() {
      try {
        const token = await source.getToken();
        if (typeof token !== 'string' || token.trim() === '') {
          throw new Error('Credential provider must return a non-empty token string');
        }
        return token;
      } catch (error) {
        // Never attach a raw cause: it may contain credentials or request headers.
        throw new Error(redact(error instanceof Error ? error.message : 'Credential provider failed'));
      }
    },
  });
}
