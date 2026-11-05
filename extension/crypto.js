// PIN-based encryption of the saved Vault tokens. WebCrypto only (works in extension pages, the service
// worker and Node for tests). The PIN itself is never stored: it derives a key with PBKDF2, and the key
// encrypts each token with AES-GCM. A wrong PIN fails AES-GCM authentication. Optional `bind` text is
// authenticated (AES-GCM additional data): a token encrypted for one Vault address cannot be decrypted
// for another.

export const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
const CHECK_TEXT = 'vault-reader-pin-check';

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// -> raw 256-bit key, base64 (kept in session storage while unlocked, dropped on lock)
export async function deriveKey(pin, saltB64, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, material, 256);
  return b64(bits);
}

const aesKey = (keyB64, usage) => crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, [usage]);

const params = (iv, bind) => ({ name: 'AES-GCM', iv, ...(bind ? { additionalData: new TextEncoder().encode(bind) } : {}) });

export async function encrypt(keyB64, text, bind = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(params(iv, bind), await aesKey(keyB64, 'encrypt'), new TextEncoder().encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

// Throws on a wrong key, a different `bind` text or tampered data.
export async function decrypt(keyB64, { iv, ct }, bind = '') {
  const pt = await crypto.subtle.decrypt(params(unb64(iv), bind), await aesKey(keyB64, 'decrypt'), unb64(ct));
  return new TextDecoder().decode(pt);
}

// New PIN -> { config to persist (salt, iterations, check blob), key for this session }.
export async function createPin(pin, iterations = PBKDF2_ITERATIONS) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(pin, salt, iterations);
  return { config: { salt, iterations, check: await encrypt(key, CHECK_TEXT) }, key };
}

// -> key if the PIN matches the config, otherwise null.
export async function verifyPin(pin, config) {
  const key = await deriveKey(pin, config.salt, config.iterations);
  try {
    return (await decrypt(key, config.check)) === CHECK_TEXT ? key : null;
  } catch {
    return null;
  }
}
