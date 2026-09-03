/**
 * AutoReg Assistant — авто-вставка OTP-кодов в поля подтверждения (v3).
 *
 * Поддерживает два вида полей:
 *  - одиночное: name/id/placeholder/autocomplete с code/otp/verif/pin/confirm;
 *  - сегментированное: несколько input[maxlength=1] (2–8 штук) — каждый
 *    input получает свою цифру.
 *
 * v3 (фикс бага «код кидается тостом, но не вставляется»):
 *  - расширенный словарь признаков кода (включая confirm/token/sms/подтвержд);
 *  - PENDING-режим: если поля ещё нет на странице (многошаговый процесс),
 *    код запоминается и вставляется, как только поле появится;
 *  - после вставки — авто-нажатие кнопки подтверждения (Verify/Confirm/
 *    Continue/Подтвердить/submit) рядом с полем, см. otpAutoConfirm.
 */

import { fillInput } from "../core/form-filler.js";

const OTP_HINT_RE = /(otp|one[-_\s]?time|verif|pin|код|code|confirm|token|sms|подтвержд|безопасност|security)/i;
const INPUT_TYPES = ["text", "tel", "number", ""];

/** Признаки кнопки подтверждения кода (auto-confirm после вставки). */
const CONFIRM_BTN_RE = /(verify|confirm|continue|submit|validate|check|далее|продолж|подтверд|провер|войти|log[\s-]?in|sign[\s-]?in)/i;

let pendingCode = null; // код, ожидающий появления поля (pending-режим)

function isVisible(input) {
  const rect = input.getBoundingClientRect?.();
  return Boolean(rect) && rect.width > 0 && rect.height > 0;
}

function attrText(input) {
  return [
    input.name,
    input.id,
    input.getAttribute?.("placeholder"),
    input.getAttribute?.("autocomplete"),
    input.getAttribute?.("aria-label"),
    input.getAttribute?.("data-testid"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Ищет поля OTP на странице.
 * @returns {{single: HTMLInputElement|null, segmented: HTMLInputElement[], any: boolean}}
 */
export function findOtpFields() {
  const all = [...document.querySelectorAll("input")].filter(
    (i) => !i.disabled && !i.readOnly && INPUT_TYPES.includes((i.getAttribute("type") || "text").toLowerCase()) && isVisible(i)
  );

  // Сегментированный ввод: группа одно-символьных полей
  const singles = all.filter((i) => (i.getAttribute("maxlength") || "") === "1");
  let segmented = [];
  if (singles.length >= 2 && singles.length <= 8) {
    // Группа должна жить в одном контейнере (form или общий родитель)
    const containers = new Set(singles.map((i) => i.closest("form")?.id ?? i.parentElement));
    if (containers.size === 1) segmented = singles;
  }

  // Одиночное поле по текстовым признакам
  const single = segmented.length
    ? null
    : all.find((i) => {
        const hint = attrText(i);
        if (!OTP_HINT_RE.test(hint)) return false;
        const max = parseInt(i.getAttribute("maxlength") || "", 10);
        return !Number.isFinite(max) || (max >= 4 && max <= 12); // код короткий
      }) ?? null;

  return { single, segmented, any: Boolean(single) || segmented.length > 0 };
}

/** Ищет кнопку подтверждения рядом с OTP-полем (или в той же форме). */
function findConfirmButton(inputs) {
  const scopes = new Set();
  for (const input of inputs) {
    if (!input) continue;
    const form = input.closest?.("form");
    if (form) scopes.add(form);
  }
  // ищем по формам; если форм нет — по общему контейнеру первого поля
  const candidates = [];
  if (scopes.size) {
    for (const form of scopes) {
      for (const btn of form.querySelectorAll('button, input[type="submit"], [role="button"]')) {
        candidates.push(btn);
      }
    }
  } else if (inputs[0]) {
    const container = inputs[0].closest?.("div,section,fieldset") ?? document;
    for (const btn of container.querySelectorAll('button, input[type="submit"], [role="button"]')) {
      candidates.push(btn);
    }
  }
  // 1) кнопки с текстом подтверждения
  for (const btn of candidates) {
    if (btn.disabled) continue;
    const label = (btn.textContent || btn.value || "").trim();
    if (label && CONFIRM_BTN_RE.test(label)) return btn;
  }
  // 2) единственная кнопка типа submit в области
  for (const btn of candidates) {
    if (btn.disabled) continue;
    const type = (btn.getAttribute?.("type") || "").toLowerCase();
    if (type === "submit") return btn;
  }
  return null;
}

/** Нажимает кнопку подтверждения (опционально, настройка otpAutoConfirm). */
function clickConfirm(inputs) {
  try {
    const btn = findConfirmButton(inputs);
    if (btn) {
      btn.click();
      return true;
    }
    // фолбэк: сабмит формы
    const form = inputs.find(Boolean)?.closest?.("form");
    if (form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    }
  } catch {
    /* клик безопасен */
  }
  return false;
}

/**
 * Вставляет код в найденное поле.
 * @param {object} [opts]
 *   code — сам код; autoConfirm — нажимать ли кнопку подтверждения после.
 * @returns {{applied: boolean, mode: "single"|"segmented"|null, confirmed: boolean}}
 */
export function fillOtp({ code, autoConfirm = false } = {}) {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (!digits) return { applied: false, mode: null, confirmed: false };
  const { single, segmented } = findOtpFields();

  if (segmented.length) {
    // Количество цифр должно совпадать с количеством полей (иначе частичный ввод
    // только запутает сайт — код останется в записи для ручного ввода)
    if (digits.length !== segmented.length) return { applied: false, mode: "segmented", confirmed: false };
    segmented.forEach((input, i) => fillInput(input, digits[i]));
    segmented[Math.min(digits.length, segmented.length) - 1]?.blur?.();
    const confirmed = autoConfirm ? clickConfirm(segmented) : false;
    return { applied: true, mode: "segmented", confirmed };
  }

  if (single) {
    fillInput(single, digits);
    const confirmed = autoConfirm ? clickConfirm([single]) : false;
    return { applied: true, mode: "single", confirmed };
  }
  return { applied: false, mode: null, confirmed: false };
}

// --- Pending-режим: поле ещё не появилось (многошаговый процесс) -------------

/** Запомнить код — вставится, как только OTP-поле появится на странице. */
export function setPendingCode(code) {
  pendingCode = code ? String(code) : null;
}

/** Текущий ожидающий код (или null). */
export function getPendingCode() {
  return pendingCode;
}

/**
 * Попытка применить ожидающий код (вызывается content-скриптом при мутациях
 * DOM). Возвращает true, если код вставился.
 */
export function tryPending({ autoConfirm = false } = {}) {
  if (!pendingCode) return { applied: false };
  const { any } = findOtpFields();
  if (!any) return { applied: false };
  const result = fillOtp({ code: pendingCode, autoConfirm });
  if (result.applied) pendingCode = null;
  return result;
}
