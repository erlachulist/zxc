/**
 * AutoReg Assistant — генерация паролей под требования конкретного поля (v3).
 *
 * Что умеет:
 *  - требования из АТРИБУТОВ: minlength / maxlength / pattern (пароль + confirm);
 *  - требования из ТЕКСТА формы (порт из v2): «at least 8 characters»,
 *    «uppercase», «цифр», «спецсимвол»… — список требований под полем;
 *  - классовая генерация: гарантированный символ каждого требуемого класса;
 *  - цикл «генерируй-и-проверяй» по pattern с чередованием наборов
 *    (full → alnum → alpha → только-нижний-регистр…).
 *
 * Фиксы багов обеих версий:
 *  - v2: charsetFromPattern добавлял литералы «^» и «$» в алфавит и всегда
 *    гарантировал спецсимвол → пароль не проходил pattern вида ^[A-Za-z0-9]{8,}$;
 *  - v1: наборы full/alnum/alpha всегда содержали заглавные → pattern без
 *    заглавных, но со спецсимволами не удовлетворялся никогда.
 * В v3 требуемые классы выводятся из текстовых требований и pattern, а
 * алфавит-фолбэк из pattern строится без якорей и квантификаторов.
 */

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SPECIAL = "!@#$%^&*";
const ALL = LOWER + UPPER + DIGITS + SPECIAL;

/** Равномерное случайное целое [0, max) без модульного смещения. */
function randInt(max) {
  if (max <= 1) return 0;
  const limit = 4294967296 - (4294967296 % max);
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

/**
 * Требования к классам символов и длине, извлечённые из текста рядом с полем
 * (порт parseTextRequirements из v2, расширенный).
 * @returns {{minLength?: number, needLower?: boolean, needUpper?: boolean,
 *            needNumber?: boolean, needSpecial?: boolean}}
 */
export function parseTextRequirements(text) {
  const out = {};
  if (!text) return out;
  const t = String(text).toLowerCase();
  const lenRes = [
    /at\s*least\s+(\d{1,2})\s*(characters|symbols|chars)/,
    /(minimum|min\.?)\s+(\d{1,2})\s*(characters|symbols|chars)/,
    /(\d{1,2})\+?\s*(characters|symbols)\s*(minimum|min\b|or more)/,
    /не\s*менее\s+(\d{1,2})\s*(символ|знак)/,
    /минимум\s+(\d{1,2})\s*(символ|знак)/,
    /(длина|длиной)\D{0,12}(\d{1,2})\s*(символ|знак)/,
  ];
  for (const re of lenRes) {
    const m = t.match(re);
    if (m) {
      const nums = m.filter((g) => g && /^\d{1,2}$/.test(g)).map(Number);
      const num = nums.length ? Math.max(...nums) : NaN;
      if (Number.isFinite(num) && num > 0 && num <= 64) {
        out.minLength = Math.max(out.minLength ?? 0, num);
        break;
      }
    }
  }
  // «от 8 до 64» / «8–64 символов»
  const range = t.match(/(?:от\s+)?(\d{1,2})\s*(?:до|-|–|—)\s*(\d{1,2})\s*(?:символ|знак|characters)/);
  if (range) {
    out.minLength = Math.max(out.minLength ?? 0, Number(range[1]) || 0);
    const hi = Number(range[2]);
    if (Number.isFinite(hi) && hi > 0) out.maxLength = hi;
  }
  if (/lowercase|lower[-\s]?case|строчн|маленьк/.test(t)) out.needLower = true;
  if (/uppercase|upper[-\s]?case|capital|заглавн|прописн|больш(ая|ие)\s*букв/.test(t)) out.needUpper = true;
  if (/\bnumber\b|\bdigit\b|цифр/.test(t)) out.needNumber = true;
  if (/special|symbol|спец|спецсимвол|(!|@|#|\$|%|\^|&|\*)\s*[^a-z0-9]{0,40}symbol/.test(t)) out.needSpecial = true;
  // «uppercase and lowercase» требует оба класса — строчные не упомянуты явно
  if (out.needUpper && /and\s*(a\s*)?lowercase|заглавн\w*\s*и\s*строчн/.test(t)) out.needLower = true;
  return out;
}

/** Наборы генерации: чередуем в цикле pattern-проверок. */
const CHARSETS = {
  full: { classes: [LOWER, UPPER, DIGITS, SPECIAL], pool: ALL },
  alnum: { classes: [LOWER, UPPER, DIGITS], pool: LOWER + UPPER + DIGITS },
  alpha: { classes: [LOWER, UPPER], pool: LOWER + UPPER },
  lowerDigits: { classes: [LOWER, DIGITS], pool: LOWER + DIGITS },
  lower: { classes: [LOWER], pool: LOWER },
};

/** Пароль с гарантированными символами классов набора (если длина позволяет). */
function buildPassword(length, mode = "full") {
  const { classes, pool } = CHARSETS[mode] ?? CHARSETS.full;
  const chars = [];
  const n = Math.min(classes.length, length);
  for (let i = 0; i < n; i++) chars.push(classes[i][randInt(classes[i].length)]);
  while (chars.length < length) chars.push(pool[randInt(pool.length)]);
  // Фишер–Йетс: обязательные символы не должны стоять в начале
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Пароль из явных классов-требований (атрибуты + текстовые подсказки).
 *  Если требований нет вовсе — консервативный дефолт v1: все 4 класса
 *  (большинство сайтов требуют верх/цифру/спец, а те, что не требуют, их принимают). */
function buildFromRequirements(length, req) {
  const noHints = !req.needUpper && !req.needNumber && !req.needSpecial;
  const classes = [];
  if (req.needLower !== false) classes.push(LOWER);
  if (req.needUpper || noHints) classes.push(UPPER);
  if (req.needNumber || noHints) classes.push(DIGITS);
  if (req.needSpecial || noHints) classes.push(SPECIAL);
  // хотя бы один класс всегда (минимум — нижний регистр)
  if (!classes.length) classes.push(LOWER);
  const pool = [...new Set(classes.join(""))].join("");
  const chars = [];
  const n = Math.min(classes.length, length);
  for (let i = 0; i < n; i++) chars.push(classes[i][randInt(classes[i].length)]);
  while (chars.length < length) chars.push(pool[randInt(pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * Пароль из заданного алфавита (например, выведенного из pattern) с
 * гарантированными классами-требованиями, пересечёнными с алфавитом.
 * Так «pattern разрешает только !@#$, но текст требует спецсимвол» даёт
 * спецсимвол именно из разрешённых.
 */
function buildFromCharsetWithRequirements(length, charset, req = {}) {
  const chars = [...new Set(String(charset).split(""))].filter(Boolean);
  if (chars.length < 2) return buildFromRequirements(length, req);
  const sets = {
    lower: chars.filter((c) => /[a-z]/.test(c)),
    upper: chars.filter((c) => /[A-Z]/.test(c)),
    digits: chars.filter((c) => /[0-9]/.test(c)),
    special: chars.filter((c) => /[^A-Za-z0-9]/.test(c)),
  };
  const required = [];
  const noHints = !req.needUpper && !req.needNumber && !req.needSpecial;
  if ((req.needLower !== false || noHints) && sets.lower.length) required.push(sets.lower);
  if ((req.needUpper || noHints) && sets.upper.length) required.push(sets.upper);
  if ((req.needNumber || noHints) && sets.digits.length) required.push(sets.digits);
  if ((req.needSpecial || noHints) && sets.special.length) required.push(sets.special);
  if (!required.length) required.push(chars);
  const out = [];
  const n = Math.min(required.length, length);
  for (let i = 0; i < n; i++) out.push(required[i][randInt(required[i].length)]);
  while (out.length < length) out.push(chars[randInt(chars.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

/** pattern → RegExp «полное совпадение»; битый pattern игнорируем. */
function compilePattern(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp("^(?:" + pattern + ")$");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}

/**
 * Фикс v2-бага: алфавит-фолбэк из pattern. Убираем якоря (^ $), квантификаторы
 * и операторы — оставляем только литералы из […] классов и \d \w.
 */
export function charsetFromPattern(pattern) {
  const out = new Set();
  const add = (c) => {
    if (c && !/[\\^$.|?*+(){}\[\]\/]/.test(c)) out.add(c);
  };
  const classRe = /\[([^\]]+)\]/g;
  let m;
  while ((m = classRe.exec(pattern))) {
    const body = m[1];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\") {
        const n = body[i + 1];
        if (n === "d") DIGITS.split("").forEach(add);
        else if (n === "w") (LOWER + UPPER + DIGITS + "_").split("").forEach(add);
        else if (n) add(n);
        i++;
        continue;
      }
      if (body[i + 1] === "-" && body[i + 2] && body[i + 2] !== "]") {
        const start = body.charCodeAt(i);
        const end = body.charCodeAt(i + 2);
        if (end - start > 0 && end - start < 100) {
          for (let c = start; c <= end; c++) add(String.fromCharCode(c));
        }
        i += 2;
        continue;
      }
      add(body[i]);
    }
  }
  if (/\\d/.test(pattern)) DIGITS.split("").forEach(add);
  if (/\\w/.test(pattern)) (LOWER + UPPER + DIGITS + "_").split("").forEach(add);
  // литералы вне классов — только простые символы
  const bare = pattern.replace(/\[[^\]]*\]/g, "").replace(/\\[dws]/g, "");
  for (const ch of bare) {
    if (/[a-z0-9!@#$%^&*_]/i.test(ch)) add(ch);
  }
  const arr = [...out];
  return arr.length >= 4 ? arr.join("") : null;
}

/**
 * Генерация пароля под все известные требования.
 *
 * @param {object} [opts]
 *   minLength, maxLength, confirmMaxLength, pattern — из атрибутов полей;
 *   textHint — текст требований рядом с формой (парсится parseTextRequirements);
 *   attempts — лимит цикла «генерируй-и-проверяй» (по умолчанию 20).
 * @returns {{password: string, length: number, patternOk: boolean,
 *            attempts: number, requirements: object}}
 */
export function generatePassword({
  minLength = 0,
  maxLength = 0,
  confirmMaxLength = 0,
  pattern = null,
  textHint = "",
  attempts = 20,
} = {}) {
  const hint = parseTextRequirements(textHint);

  // Итоговые границы длины: минимум 12 (без ограничений — 14–16), максимум —
  // самый строгий из ограничений; текстовые требования усиливают минимум.
  const hardMax = Math.min(maxLength || Infinity, confirmMaxLength || Infinity, hint.maxLength || Infinity);
  const unlimited = hardMax === Infinity;
  let lo = Math.max(Number(minLength) || 0, hint.minLength || 0, unlimited ? 14 : 8);
  let hi = unlimited ? Math.max(16, lo) : hardMax;
  if (hi < lo) hi = lo; // сайт требует maxlength < minlength — доверяем более длинному
  const length = hi - lo >= 2 ? lo + randInt(hi - lo + 1) : hi;

  const re = compilePattern(pattern);
  const req = { ...hint };

  // Стратегия 1: генерация по явным классам-требованиям
  let pw = buildFromRequirements(length, req);
  let patternOk = true;
  let used = 0;

  if (re) {
    // Полная приемлемость: pattern + текстовые требования одновременно
    const okFull = (p) => re.test(p) && meetsTextRequirements(p, textHint);
    if (!okFull(pw)) {
      // Стратегия 2: алфавит из pattern + обязательные классы, пересечённые
      // с алфавитом (спецсимвол — только из разрешённых pattern-ом)
      const patCharset = charsetFromPattern(pattern);
      const generators = [];
      if (patCharset) generators.push(() => buildFromCharsetWithRequirements(length, patCharset, req));
      // Стратегия 3: чередуем наборы — pattern без заглавных/без спецсимволов
      for (const mode of ["full", "alnum", "alpha", "lowerDigits", "lower"]) {
        generators.push(() => buildPassword(length, mode));
      }
      patternOk = false;
      const perGen = Math.max(2, Math.ceil(attempts / generators.length));
      for (const gen of generators) {
        for (let i = 0; i < perGen && !patternOk; i++) {
          used++;
          pw = gen();
          patternOk = okFull(pw);
        }
        if (patternOk) break;
      }
      // Последняя надежда: согласиться хотя бы с pattern (требования текста
      // слишком экзотичны для алфавита) — код останется в записи для ручной правки
      if (!patternOk) {
        for (let i = 0; i < attempts && !patternOk; i++) {
          used++;
          pw = buildPassword(length, ["full", "alnum", "alpha", "lowerDigits", "lower"][i % 5]);
          patternOk = re.test(pw);
        }
      }
    }
  }
  return { password: pw, length, patternOk, attempts: used, requirements: hint };
}

/** Username из локальной части адреса: milly42@x.com → milly42 (запасной user_NNNNN). */
export function generateUsername(email) {
  const local = String(email ?? "").split("@")[0] || "";
  const clean = local.replace(/[^a-z0-9._-]/gi, "").slice(0, 20);
  return clean.length >= 4 ? clean : `user_${randInt(90000) + 10000}`;
}

/** Проверка пароля против текстовых требований (для REGENERATE_PASSWORD). */
export function meetsTextRequirements(password, textHint = "") {
  const req = parseTextRequirements(textHint);
  const pw = String(password ?? "");
  if (req.minLength && pw.length < req.minLength) return false;
  if (req.needUpper && !/[A-Z]/.test(pw)) return false;
  if (req.needLower && !/[a-z]/.test(pw)) return false;
  if (req.needNumber && !/[0-9]/.test(pw)) return false;
  if (req.needSpecial && !/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}
