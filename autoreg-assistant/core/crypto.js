/**
 * AutoReg Assistant — опциональное шифрование паролей мастер-паролем (v3,
 * порт из v2, переведён на ES-модули).
 *
 * PBKDF2 (SHA-256, 200k итераций) → ключ AES-GCM. WebCrypto.
 * Формат зашифрованной строки: "v1.<ivBase64>.<cipherBase64>".
 * Ключ живёт только в памяти контекста (не сохраняется на диск);
 * мастер-пароль в сессии — chrome.storage.session.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Ключ AES-GCM из мастер-пароля и соли (base64). */
export async function deriveKey(password, saltB64) {
  const salt = b64ToBuf(saltB64);
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Новая соль (base64, 16 байт). */
export function newSalt() {
  return bufToB64(randomBytes(16));
}

/** Шифрует строку → "v1.<iv>.<cipher>". */
export async function encryptString(key, plaintext) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1.${bufToB64(iv)}.${bufToB64(ct)}`;
}

/** Расшифровывает "v1.<iv>.<cipher>" → строку (бросает при неверном ключе). */
export async function decryptString(key, packed) {
  const parts = String(packed).split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Некорректный формат шифра");
  const iv = b64ToBuf(parts[1]);
  const ct = b64ToBuf(parts[2]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}

/** Верификатор — шифрует известную строку, чтобы позже проверить пароль. */
export async function makeVerifier(key) {
  return encryptString(key, "autoreg-verify");
}

export async function checkVerifier(key, verifier) {
  try {
    return (await decryptString(key, verifier)) === "autoreg-verify";
  } catch {
    return false;
  }
}

/** Похоже ли значение на зашифрованное (v1.…). */
export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("v1.");
}
