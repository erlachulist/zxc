/**
 * AutoReg Assistant — классификация ошибок регистрации по тексту страницы.
 *
 * Вызывается из background после ERROR_SUBMITTED {recordId, pageText} от
 * контента. Порядок правил важен: сначала специфичные доменные ошибки,
 * затем «общие».
 *
 * Маппинг (фаза 6):
 *   disposable/temporary …            → domain_rejected
 *   already registered / in use …     → email_taken
 *   not allowed / blocked …           → domain_rejected
 *   invalid …                         → unknown
 */

const RULES = [
  {
    // v3: слиты правила v1 и v2; \w не используется для кириллицы (баг v2 —
    // «одноразовую почту» не классифицировалась из-за \w без кириллицы)
    errorType: "domain_rejected",
    re: /(disposable|temporary\s*(e-?mail|mail|address|box)|temp[-\s]?mail|tempmail|throwaway|one[-\s]?time\s*(e-?mail|mail)|burner\s*(e-?mail|mail)|одноразов|временн(ая|ый|ое|ые)\s*(почт|ящик|адрес)|недопустим(ый|ая|ое)\s*(домен|email|почт))/i,
  },
  {
    errorType: "email_taken",
    re: /(already\s+(registered|in\s*use|exists|has\s+an?\s*account|associated|taken)|is\s+already\s+taken|account\s+(already\s+)?exists|user\s+already|уже\s*(зарегистрирован|используется|занят|существует)|такой\s*(email|аккаунт)\s*уже|занят)/i,
  },
  {
    errorType: "domain_rejected",
    re: /(not\s+(allowed|permitted|accepted)|is\s+blocked|blacklisted|blocked|forbidden|заблокир|запрещ[ёе]н|не\s*допуска|не\s*поддержива|не\s*разреш[ёе]н)/i,
  },
  { errorType: "unknown", re: /(invalid|incorrect|wrong|неверн|некорректн|ошибк)/i },
];

/**
 * Классифицирует текст страницы.
 * @param {string} pageText — видимый текст ошибки со страницы.
 * @returns {{errorType: string, snippet: string} | null} — null, если признаков нет.
 */
export function classifyPageText(pageText) {
  const text = String(pageText ?? "");
  if (!text.trim()) return null;
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) {
      // Сниппет: 80 символов вокруг совпадения — для лога попыток
      const from = Math.max(0, m.index - 40);
      const snippet = text.slice(from, Math.min(text.length, m.index + m[0].length + 40)).trim();
      return { errorType: rule.errorType, snippet: snippet.slice(0, 160) };
    }
  }
  return null;
}

/** Домен email-адреса (после @, в нижнем регистре) — для блэклистов. */
export function emailDomainOf(email) {
  const domain = String(email ?? "").split("@")[1] ?? "";
  return domain.toLowerCase();
}
