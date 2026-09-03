/**
 * AutoReg Assistant — движок повторных попыток (фаза 6).
 *
 * Политика ошибок:
 *   network / provider_unavailable / rate_limit → повтор с экспоненциальным
 *     backoff (failover между провайдерами добавляет registry — фаза 7);
 *   domain_rejected → НОВЫЙ email, отклонённый домен уходит в чёрный список
 *     сайта (persist в ar_domainBlacklist);
 *   email_taken     → полностью новый email;
 *   unknown         → пауза: авто-ретрай не делаем, показываем пользователю;
 *   попытки исчерпаны (attempt >= maxRetries) → stop, статус failed.
 */

const MAX_DELAY_MS = 60000;

/**
 * Задержка экспоненциального backoff: base * 2^attempt (1s, 2s, 4s…), кап 60 с.
 * @param {number} attempt — номер попытки, начиная с 0.
 * @param {number} baseMs  — retryBaseDelayMs из настроек.
 */
export function backoffDelay(attempt, baseMs = 1000) {
  const base = Math.max(Number(baseMs) || 1000, 100);
  return Math.min(base * 2 ** Math.max(Number(attempt) || 0, 0), MAX_DELAY_MS);
}

/**
 * Решение по следующей попытке.
 * @param {string} errorType — тип ошибки из протокола.
 * @param {number} attempt   — сколько попыток уже сделано (длина attempts[]).
 * @param {object} [settings] — {maxRetries, retryBaseDelayMs}
 * @returns {{action: "retry"|"newEmail"|"pause"|"stop", delayMs: number, reason: string}}
 */
export function decideRetry(errorType, attempt, settings = {}) {
  const maxRetries = Math.max(Number(settings.maxRetries ?? 3), 1);
  const made = Number(attempt) || 0;

  if (made >= maxRetries) {
    return { action: "stop", delayMs: 0, reason: `Исчерпан лимит попыток (${maxRetries})` };
  }

  switch (errorType) {
    case "network":
    case "provider_unavailable":
    case "rate_limit":
      return { action: "retry", delayMs: backoffDelay(made, settings.retryBaseDelayMs), reason: "Сбой сети/провайдера — повтор с задержкой" };
    case "domain_rejected":
      return { action: "newEmail", delayMs: backoffDelay(made, settings.retryBaseDelayMs), reason: "Домен email отклонён сайтом — нужен новый адрес" };
    case "email_taken":
      return { action: "newEmail", delayMs: backoffDelay(made, settings.retryBaseDelayMs), reason: "Email уже занят — нужен новый адрес" };
    default:
      // unknown и прочее: не угадываем, отдаём пользователю
      return { action: "pause", delayMs: 0, reason: "Неизвестная ошибка — требуется внимание пользователя" };
  }
}

/** Спит заданное число мс (удобно для тестов и фоновых пауз). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
