/**
 * AutoReg Assistant — схема данных и значения по умолчанию.
 *
 * Все данные расширения лежат в chrome.storage.local под ключами ar_*:
 *   ar_schemaVersion    — версия схемы (для миграций);
 *   ar_records          — список записей о регистрациях (новые — в начале);
 *   ar_domainBlacklist  — { домен сайта: [заблокированные email-домены] };
 *   ar_siteProvider     — { домен сайта: имя последнего успешного провайдера };
 *   ar_providers        — { builtin: { id: enabled }, custom: [конфиги] };
 *   ar_settings         — настройки пользователя.
 */

export const SCHEMA_VERSION = 1;

/** Жизненный цикл записи о регистрации. */
export const RECORD_STATUS = {
  GENERATED: "generated",
  FORM_FILLED: "form_filled",
  SUBMITTED: "submitted",
  PENDING_VERIFICATION: "pending_verification",
  VERIFIED: "verified",
  FAILED: "failed",
};

/** Настройки по умолчанию (заполняются по ключам, чтобы будущие версии бесшовно добавляли поля).
 *  fillMode по умолчанию "email+password": фаза 3 требует, чтобы пароль попадал в форму
 *  и проходил валидацию сайта (DoD), а username — опция режима "full".
 *  v3: otpAutoConfirm — авто-нажатие кнопки подтверждения после вставки кода;
 *      autofillSteps — авто-заполнение новых полей многошаговой формы;
 *      loginOffer — баннер «Войти как {email}» на форме логина. */
export const DEFAULT_SETTINGS = {
  providerStrategy: "rotation", // rotation | random | perSiteSuccess
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  autoSubmit: false,
  fillMode: "email+password", // email | email+password | full
  pollingIntervalMs: 5000,
  pollingTimeoutMs: 300000,
  linkMode: "auto", // auto | manual
  notifications: true,
  autoDeleteDays: 0,
  encryptionEnabled: false,
  otpAutoConfirm: true,
  autofillSteps: true,
  loginOffer: true,
};

/** Включённость встроенных провайдеров (фаза 7: все три включены по умолчанию). */
export const DEFAULT_PROVIDERS = {
  builtin: { "tempmail-lol": true, "mail-tm": true, "guerrillamail": true },
  custom: [],
};

/** Полное состояние по умолчанию — записывается при первой установке. */
export function defaultState() {
  return {
    ar_schemaVersion: SCHEMA_VERSION,
    ar_records: [],
    ar_domainBlacklist: {},
    ar_siteProvider: {},
    ar_providers: { builtin: { ...DEFAULT_PROVIDERS.builtin }, custom: [] },
    ar_settings: { ...DEFAULT_SETTINGS },
  };
}

/**
 * UUID v4 (RFC 4122). В service worker и страницах расширения доступен
 * crypto.randomUUID; запасной путь — для окружений без него (автотесты, старые Chrome).
 */
export function uuid() {
  if (globalThis.crypto?.randomUUID) {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      /* падаем в запасный путь */
    }
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
