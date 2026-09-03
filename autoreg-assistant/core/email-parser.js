/**
 * AutoReg Assistant — извлечение OTP-кодов и ссылок подтверждения из писем.
 *
 * Сообщение: { from, subject, body, html?, receivedAt }. body — текст, html —
 * исходная разметка (если провайдер её отдаёт). v3.1: ссылки берём и из
 * href="…" в html (письма-кнопки без текстового URL), html-сущности
 * декодируем (&amp; в query-строке), «текст» для OTP — body либо html без тегов.
 *
 * Правила:
 *  - OTP: \b\d{4,8}\b + контекст-слова (code, verification, confirm, pin,
 *    и русские аналоги) в теме или в тексте рядом с числом;
 *  - ссылки: все http(s) URL из текста и href, приоритет тем, где в URL есть
 *    verify/confirm/activate/token/validate; служебные (unsubscribe, соцсети,
 *    картинки) отбрасываются.
 */

const OTP_RE = /\b(\d{4,8})\b/g;
const OTP_CONTEXT_RE = /(code|verification|verify|confirm|pin|passcode|one[-\s]?time|otp|security|код|провер|подтвер|однораз|парол)/i;
const URL_RE = /https?:\/\/[^\s"'<>\\)\]}]+/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const URL_GOOD_RE = /(verify|verification|confirm|activate|activation|token|validate|auth|signup|register|подтвер|актив)/i;
const URL_BAD_RE = /(unsubscribe|отпис|privacy|terms|policy|logo|icon|\.png|\.jpe?g|\.svg|\.gif|\.css|facebook\.com|twitter\.com|x\.com\/|instagram\.com|linkedin\.com|t\.me\/|youtube\.com|mailto:)/i;

/** Декодирует html-сущности, встречающиеся в URL и тексте писем. */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Убирает разметку: текст письма для поиска кода. */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Текст письма: body, а если он пуст — html без тегов. Если body сам html — тоже чистим. */
function messageText(msg) {
  const body = String(msg?.body ?? "");
  if (body.trim()) return /<[a-z][\s\S]*>/i.test(body) ? stripHtml(body) : body;
  return stripHtml(msg?.html);
}

/** Собирает контекст вокруг совпадения (±60 символов) для проверки слов-признаков. */
function contextAround(text, index, matched, radius = 60) {
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + matched.length + radius);
  return text.slice(from, to);
}

/**
 * Ищет лучший OTP-код в наборе писем.
 * Приоритет: наличие контекст-слова > близость к теме > длина 6 > свежесть.
 * @param {Array<{subject: string, body: string, html?: string}>} messages
 * @returns {{code: string, subject: string} | null}
 */
export function extractOtp(messages) {
  let best = null;
  let bestScore = -1;
  for (const msg of messages ?? []) {
    const subject = String(msg.subject ?? "");
    const body = messageText(msg);
    const subjectHit = OTP_CONTEXT_RE.test(subject);
    // Код может стоять прямо в теме («Your code is 482913»)
    const haystacks = [body, subject];
    for (const text of haystacks) {
      OTP_RE.lastIndex = 0;
      let m;
      while ((m = OTP_RE.exec(text)) !== null) {
        const code = m[1];
        // Годы и цены почти никогда не являются OTP
        if (/^(19|20)\d{2}$/.test(code) && !subjectHit) continue;
        const ctx = contextAround(text, m.index, code);
        const hasCtx = OTP_CONTEXT_RE.test(ctx);
        if (!hasCtx && !subjectHit) continue;
        let score = (hasCtx ? 2 : 0) + (subjectHit ? 2 : 0) + (code.length === 6 ? 1 : 0) + code.length / 10;
        if (score > bestScore) {
          bestScore = score;
          best = { code, subject };
        }
      }
    }
  }
  return best;
}

/** Нормализует URL: хвостовая пунктуация, html-сущности. */
function cleanUrl(raw) {
  return decodeEntities(raw).replace(/[.,;:!?\u201d\u2019]+$/, "");
}

/**
 * Собирает ссылки из писем, отсортированные по «полезности».
 * @param {Array<{subject: string, body: string, html?: string}>} messages
 * @returns {Array<string>} — уникальные URL, лучшие первыми (максимум 5)
 */
export function extractLinks(messages) {
  const scores = new Map();
  const consider = (raw) => {
    const url = cleanUrl(raw);
    if (!/^https?:\/\//i.test(url)) return;
    if (URL_BAD_RE.test(url)) return;
    const good = URL_GOOD_RE.test(url);
    const score = (good ? 2 : 0) + (good && /verify|confirm|activate|подтвер|актив/i.test(url) ? 1 : 0);
    scores.set(url, Math.max(scores.get(url) ?? 0, score));
  };
  for (const msg of messages ?? []) {
    const html = String(msg.html ?? "");
    const text = String(msg.subject ?? "") + "\n" + String(msg.body ?? "") + "\n" + html;
    HREF_RE.lastIndex = 0;
    let m;
    while ((m = HREF_RE.exec(html)) !== null) consider(m[1]);
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) consider(m[0]);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([url]) => url);
}

/**
 * Полный разбор писем: код + приоритетная ссылка одним вызовом.
 * link — только ссылка с признаками подтверждения; прочие URL (сайт сервиса,
 * футер) остаются в links[], но не считаются ссылкой верификации — иначе
 * приветственное письмо самого провайдера «подтверждало» бы регистрацию.
 * @returns {{code: string|null, link: string|null, links: string[]}}
 */
export function parseMessages(messages) {
  const otp = extractOtp(messages);
  const links = extractLinks(messages);
  return {
    code: otp?.code ?? null,
    link: links.find((u) => URL_GOOD_RE.test(u)) ?? null,
    links,
  };
}
