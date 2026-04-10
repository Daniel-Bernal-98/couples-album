const te = new TextEncoder();
const td = new TextDecoder();

export function toB64(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
export function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0; i<bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2,"0")).join("");
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(str));
  return toHex(new Uint8Array(digest));
}

export async function deriveKeyFromPassphrase(passphrase, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    te.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function aesGcmEncrypt(key, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plainBytes
  );
  return { ivBytes: iv, cipherBytes: new Uint8Array(cipher) };
}

export async function aesGcmDecrypt(key, ivBytes, cipherBytes) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    cipherBytes
  );
  return new Uint8Array(plain);
}

export function jsonToBytes(obj) {
  return te.encode(JSON.stringify(obj));
}
export function bytesToJson(bytes) {
  return JSON.parse(td.decode(bytes));
}
