/* options/options.js — v3: все настройки (v1) + шифрование + провайдеры +
 * статистика, в дизайн-системе v2. Вся логика хранения — в background. */

(function () {
  "use strict";

  const SAMPLE = {
    name: "MyProvider",
    apiKey: "",
    domains: ["example.com"],
    createInbox: {
      method: "POST",
      url: "https://api.example.com/inbox",
      headers: { Authorization: "Bearer {{apiKey}}" },
      body: { ttl: 3600 },
      responseMapping: { email: "data.address", token: "data.token" },
    },
    getMessages: {
      method: "GET",
      url: "https://api.example.com/inbox/{{token}}",
      responseMapping: {
        messages: "data.emails",
        from: "sender",
        subject: "title",
        body: "text",
        receivedAt: "date",
      },
    },
  };

  const state = { settings: {}, providers: { builtin: [], custom: [] }, crypto: { enabled: false, unlocked: false }, records: [] };

  const $ = (s, r = document) => r.querySelector(s);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props)
      for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "text") n.textContent = v;
        else if (k === "dataset") Object.assign(n.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
      }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function rpc(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
        const e = chrome.runtime.lastError;
        if (e) return reject(new Error(e.message));
        if (!resp) return reject(new Error("Нет ответа от расширения"));
        if (resp.ok === false) return reject(new Error(typeof resp.error === "string" ? resp.error : (resp.error && resp.error.message) || "Ошибка"));
        resolve(resp);
      });
    });
  }

  let toastTimer = null;
  function toast(text, ok = true) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast show " + (ok ? "ok" : "err");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 2800);
  }

  function download(filename, text, mime) {
    const blob = new Blob(["\ufeff" + text], { type: mime || "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }

  // --- элементы управления строк настроек -----------------------------------

  function switchLine(title, sub, checked, onchange) {
    const input = el("input", { type: "checkbox" });
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onchange(input.checked));
    const sw = el("label", { class: "switch" }, input, el("span", { class: "track" }));
    return el("div", { class: "line" }, el("div", { class: "line-txt" }, el("div", { class: "line-title" }, title), sub ? el("div", { class: "line-sub" }, sub) : null), el("div", { class: "line-ctrl" }, sw));
  }

  function selectLine(title, sub, options, value, onchange) {
    const sel = el("select", { class: "select" });
    for (const [v, label] of options) sel.append(el("option", { value: v, text: label }));
    sel.value = value;
    sel.addEventListener("change", () => onchange(sel.value));
    return el("div", { class: "line" }, el("div", { class: "line-txt" }, el("div", { class: "line-title" }, title), sub ? el("div", { class: "line-sub" }, sub) : null), el("div", { class: "line-ctrl" }, sel));
  }

  function numLine(title, sub, value, { min = 0, max = 1e9, suffix = "" }, onchange) {
    const input = el("input", { class: "input num", type: "number", min, max });
    input.value = value;
    input.addEventListener("change", () => onchange(Number(input.value)));
    return el("div", { class: "line" }, el("div", { class: "line-txt" }, el("div", { class: "line-title" }, title), sub ? el("div", { class: "line-sub" }, sub) : null), el("div", { class: "line-ctrl" }, input, suffix ? el("span", { class: "suffix" }, suffix) : null));
  }

  async function save(patch) {
    try {
      const r = await rpc("SAVE_SETTINGS", { settings: patch });
      state.settings = r.settings;
      toast("Сохранено");
    } catch (e) {
      toast(e.message, false);
    }
  }

  // --- секции ----------------------------------------------------------------

  function renderFill() {
    const g = $("#grp-fill");
    g.innerHTML = "";
    const s = state.settings;
    g.append(
      selectLine(
        "Режим заполнения",
        "email — только адрес; email+пароль — адрес и пароль с подтверждением; full — плюс имя пользователя.",
        [["email", "Только email"], ["email+password", "Email + пароль"], ["full", "Всё (email, пароль, имя)"]],
        s.fillMode || "email+password",
        (v) => save({ fillMode: v })
      ),
      switchLine(
        "Авто-отправка формы",
        "Расширение само нажимает кнопку регистрации после заполнения. Настоятельно рекомендуется проверять данные до включения.",
        s.autoSubmit,
        (v) => save({ autoSubmit: v })
      ),
      switchLine(
        "Многошаговые формы",
        "Автозаполнение новых полей следующих шагов (пароль на шаге 2) теми же данными — с перегенерацией пароля под более строгие требования.",
        s.autofillSteps !== false,
        (v) => save({ autofillSteps: v })
      ),
      switchLine(
        "Авто-подтверждение кода",
        "После вставки OTP-кода расширение само нажимает кнопку подтверждения (Verify/Confirm/Continue).",
        s.otpAutoConfirm !== false,
        (v) => save({ otpAutoConfirm: v })
      )
    );
  }

  function renderVerify() {
    const g = $("#grp-verify");
    g.innerHTML = "";
    const s = state.settings;
    g.append(
      numLine("Интервал опроса почты", "Как часто проверять входящие после отправки формы.", s.pollingIntervalMs ?? 5000, { min: 3000, max: 600000, suffix: "мс" }, (v) => save({ pollingIntervalMs: v })),
      numLine("Таймаут ожидания письма", "Сколько ждать письмо с кодом/ссылкой, прежде чем запись помечается ошибкой.", s.pollingTimeoutMs ?? 300000, { min: 15000, max: 3600000, suffix: "мс" }, (v) => save({ pollingTimeoutMs: v })),
      selectLine("Ссылки подтверждения", "auto — открывать в фоновой вкладке сразу; manual — показать баннер с кнопкой.", [["auto", "Авто (фоновая вкладка)"], ["manual", "Вручную (баннер)"]], s.linkMode || "auto", (v) => save({ linkMode: v })),
      switchLine("Уведомления", "Системные уведомления о письмах, кодах и завершении регистрации.", s.notifications !== false, (v) => save({ notifications: v })),
      switchLine("Предлагать вход с сохранёнными данными", "На форме логина знакомого сайта показывать баннер «Войти как {email}».", s.loginOffer !== false, (v) => save({ loginOffer: v }))
    );
  }

  function renderReliability() {
    const g = $("#grp-reliability");
    g.innerHTML = "";
    const s = state.settings;
    g.append(
      selectLine(
        "Стратегия выбора провайдера",
        "rotation — по кругу; random — случайно; perSiteSuccess — запоминать провайдера, сработавшего на сайте.",
        [["rotation", "Ротация"], ["random", "Случайно"], ["perSiteSuccess", "Успешный для сайта"]],
        s.providerStrategy || "rotation",
        (v) => save({ providerStrategy: v })
      ),
      numLine("Максимальное число повторов", "Повторные попытки после ошибок сайта (новый email и заполнение).", s.maxRetries ?? 3, { min: 0, max: 10 }, (v) => save({ maxRetries: v })),
      numLine("Базовая задержка повтора", "Задержка растёт экспоненциально (x2, максимум 60 с).", s.retryBaseDelayMs ?? 1000, { min: 100, max: 60000, suffix: "мс" }, (v) => save({ retryBaseDelayMs: v })),
      numLine("Авто-удаление старых записей", "0 — никогда. Подтверждённые записи (с паролями) не удаляются никогда.", s.autoDeleteDays ?? 0, { min: 0, max: 365, suffix: "дн" }, (v) => save({ autoDeleteDays: v }))
    );
  }

  // --- провайдеры -------------------------------------------------------------

  function renderProviders() {
    const list = $("#provider-list");
    list.innerHTML = "";

    for (const p of state.providers.builtin || []) {
      list.append(providerCard({ id: p.id, name: p.name, domains: p.domains, enabled: p.enabled, built: true }));
    }
    for (const c of state.providers.custom || []) {
      list.append(providerCard({ id: c.id, name: c.name, domains: c.domains, enabled: c.enabled !== false, built: false, config: c.config ?? c }));
    }
  }

  function providerCard({ id, name, domains, enabled, built, config }) {
    const input = el("input", { type: "checkbox" });
    input.checked = Boolean(enabled);
    input.addEventListener("change", async () => {
      try {
        await rpc("SET_PROVIDER_ENABLED", { id, enabled: input.checked });
        toast(input.checked ? "Провайдер включён" : "Провайдер выключен");
      } catch (e) {
        toast(e.message, false);
      }
    });

    const card = el(
      "div",
      { class: "prov" },
      el(
        "div",
        { class: "prov-top" },
        el(
          "div",
          {},
          el("div", { class: "prov-name" }, name, el("span", { class: "badge " + (built ? "built" : "custom") }, built ? "встроенный" : "свой")),
          domains && domains.length ? el("div", { class: "prov-domains" }, domains.join(", ")) : null
        ),
        el(
          "div",
          { class: "prov-actions" },
          !built
            ? el(
                "button",
                {
                  class: "btn btn-sm btn-danger",
                  onclick: async () => {
                    try {
                      const customs = (state.providers.custom || []).filter((c) => c.id !== id);
                      await rpc("SAVE_CUSTOM_PROVIDERS", { custom: customs });
                      await reload();
                      renderProviders();
                      toast("Провайдер удалён");
                    } catch (e) {
                      toast(e.message, false);
                    }
                  },
                },
                "Удалить"
              )
            : null,
          el("label", { class: "switch" }, input, el("span", { class: "track" }))
        )
      )
    );
    return card;
  }

  function wireProviders() {
    $("#btn-sample").addEventListener("click", () => {
      $("#custom-json").value = JSON.stringify(SAMPLE, null, 2);
    });
    $("#btn-add-prov").addEventListener("click", async () => {
      const raw = $("#custom-json").value.trim();
      if (!raw) return toast("Вставьте JSON-конфиг провайдера", false);
      let cfg;
      try {
        cfg = JSON.parse(raw);
      } catch (e) {
        return toast("Некорректный JSON: " + e.message, false);
      }
      try {
        // Сначала живой тест
        const t = await rpc("TEST_CUSTOM_PROVIDER", { config: cfg });
        toast("Тест пройден: создан " + t.email);
      } catch (e) {
        toast("Тест не пройден: " + e.message, false);
      }
      try {
        const customs = [...(state.providers.custom || []), { ...cfg, enabled: true }];
        await rpc("SAVE_CUSTOM_PROVIDERS", { custom: customs });
        await reload();
        renderProviders();
        toast("Провайдер добавлен");
      } catch (e) {
        toast(e.message, false);
      }
    });
  }

  // --- безопасность -----------------------------------------------------------

  function renderSecurity() {
    const g = $("#grp-security");
    g.innerHTML = "";
    const c = state.crypto;

    const statusLine = el(
      "div",
      { class: "line" },
      el(
        "div",
        { class: "line-txt" },
        el("div", { class: "line-title" }, "Шифрование паролей"),
        el("div", { class: "line-sub" }, c.enabled ? (c.unlocked ? "Включено · разблокировано (до перезапуска браузера)." : "Включено · заблокировано — введите мастер-пароль.") : "Выключено — пароли хранятся в открытом виде.")
      ),
      el(
        "div",
        { class: "line-ctrl" },
        c.enabled && c.unlocked
          ? el(
              "button",
              {
                class: "btn btn-sm",
                onclick: async () => {
                  try {
                    await rpc("CRYPTO_LOCK");
                    await reload();
                    renderSecurity();
                    toast("Заблокировано");
                  } catch (e) {
                    toast(e.message, false);
                  }
                },
              },
              "Заблокировать"
            )
          : null
      )
    );
    g.append(statusLine);

    if (!c.enabled) {
      // Установка
      const pw = el("input", { class: "input", type: "password", placeholder: "Новый мастер-пароль (мин. 4)" });
      const pw2 = el("input", { class: "input", type: "password", placeholder: "Повторите пароль" });
      const row = el(
        "div",
        { class: "line" },
        el(
          "div",
          { class: "line-txt" },
          el("div", { class: "line-title" }, "Включить шифрование"),
          el("div", { class: "line-sub" }, "Пароли записей шифруются AES-GCM; ключ выводится из мастер-пароля (PBKDF2, 200000 итераций). Все существующие пароли будут зашифрованы."),
          el("div", { class: "sec-row" }, pw, pw2)
        ),
        el(
          "div",
          { class: "line-ctrl" },
          el(
            "button",
            {
              class: "btn btn-sm btn-primary",
              onclick: async () => {
                if (pw.value.length < 4) return toast("Пароль слишком короткий", false);
                if (pw.value !== pw2.value) return toast("Пароли не совпадают", false);
                try {
                  await rpc("CRYPTO_SETUP", { password: pw.value });
                  await reload();
                  renderSecurity();
                  toast("Шифрование включено");
                } catch (e) {
                  toast(e.message, false);
                }
              },
            },
            "Включить"
          )
        )
      );
      g.append(row);
    } else if (!c.unlocked) {
      // Разблокировка
      const pw = el("input", { class: "input", type: "password", placeholder: "Мастер-пароль" });
      g.append(
        el(
          "div",
          { class: "line" },
          el(
            "div",
            { class: "line-txt" },
            el("div", { class: "line-title" }, "Разблокировать"),
            el("div", { class: "line-sub" }, "Введите мастер-пароль, чтобы показывать и копировать пароли записей."),
            el("div", { class: "sec-row" }, pw)
          ),
          el(
            "div",
            { class: "line-ctrl" },
            el(
              "button",
              {
                class: "btn btn-sm btn-primary",
                onclick: async () => {
                  try {
                    await rpc("CRYPTO_UNLOCK", { password: pw.value });
                    await reload();
                    renderSecurity();
                    toast("Разблокировано");
                  } catch (e) {
                    toast(e.message, false);
                  }
                },
              },
              "Разблокировать"
            )
          )
        )
      );
    }

    if (c.enabled) {
      const pw = el("input", { class: "input", type: "password", placeholder: "Мастер-пароль" });
      g.append(
        el(
          "div",
          { class: "line" },
          el(
            "div",
            { class: "line-txt" },
            el("div", { class: "line-title" }, "Выключить шифрование"),
            el("div", { class: "line-sub" }, "Все пароли будут расшифрованы и останутся в открытом виде."),
            el("div", { class: "sec-row" }, pw)
          ),
          el(
            "div",
            { class: "line-ctrl" },
            el(
              "button",
              {
                class: "btn btn-sm btn-danger",
                onclick: async () => {
                  try {
                    await rpc("CRYPTO_DISABLE", { password: pw.value });
                    await reload();
                    renderSecurity();
                    toast("Шифрование выключено");
                  } catch (e) {
                    toast(e.message, false);
                  }
                },
              },
              "Выключить"
            )
          )
        )
      );
    }
  }

  // --- данные -----------------------------------------------------------------

  function wireData() {
    $("#exp-json").addEventListener("click", async () => {
      try {
        const r = await rpc("GET_RECORDS");
        if (!(r.records || []).length) return toast("Нет данных для экспорта", false);
        download("autoreg-records-" + Date.now() + ".json", JSON.stringify(r.records, null, 2), "application/json");
        toast("Экспортировано " + r.records.length + " записей");
      } catch (e) {
        toast(e.message, false);
      }
    });

    $("#exp-keepass").addEventListener("click", async () => {
      try {
        const r = await rpc("GET_RECORDS");
        const records = r.records || [];
        if (!records.length) return toast("Нет данных для экспорта", false);
        const rows = [["Group", "Title", "Username", "Password", "URL", "Notes"]];
        let locked = 0;
        for (const rec of records) {
          let password = rec.password || "";
          if (typeof password === "string" && password.startsWith("v1.")) {
            const d = await rpc("DECRYPT_PASSWORD", { recordId: rec.id });
            if (d.locked) {
              locked++;
              password = "";
            } else password = d.password || "";
          }
          rows.push([
            rec.domain || "AutoReg",
            (rec.siteName || rec.domain || rec.email || "").replace(/"/g, "'"),
            rec.email || "",
            password,
            rec.url || "",
            (rec.notes || "").replace(/"/g, "'").replace(/\n/g, " "),
          ]);
        }
        if (locked) toast(`${locked} паролей пропущены — разблокируйте шифрование`, false);
        const csv = rows.map((cells) => cells.map((c) => '"' + String(c ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
        download("autoreg-keepass-" + Date.now() + ".csv", csv);
        toast("CSV готов");
      } catch (e) {
        toast(e.message, false);
      }
    });

    $("#clear-all").addEventListener("click", async () => {
      if (!confirm("Удалить ВСЕ записи журнала? Действие необратимо.")) return;
      try {
        const r = await rpc("GET_RECORDS");
        for (const rec of r.records || []) {
          await rpc("DELETE_RECORD", { recordId: rec.id });
        }
        await reload();
        renderStats();
        toast("Журнал очищен");
      } catch (e) {
        toast(e.message, false);
      }
    });
  }

  // --- статистика ---------------------------------------------------------------

  function renderStats() {
    const box = $("#stats");
    box.innerHTML = "";
    const records = state.records;
    const total = records.length;
    const verified = records.filter((r) => r.status === "verified").length;
    const failed = records.filter((r) => r.status === "failed").length;
    const pending = records.filter((r) => r.status === "submitted" || r.status === "pending_verification").length;

    box.append(
      statCard(total, "всего записей"),
      statCard(verified, "подтверждено"),
      statCard(pending, "ждут письма"),
      statCard(failed, "ошибки")
    );

    // по сайтам
    const sites = new Map();
    for (const r of records) {
      const key = r.domain || "(без сайта)";
      const cur = sites.get(key) || { ok: 0, fail: 0 };
      if (r.status === "verified") cur.ok++;
      if (r.status === "failed") cur.fail++;
      sites.set(key, cur);
    }
    if (sites.size) {
      const rows = [...sites.entries()].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail)).slice(0, 8);
      const max = Math.max(1, ...rows.map(([, v]) => v.ok + v.fail));
      const bars = el("div", { class: "bars" });
      for (const [site, v] of rows) {
        bars.append(
          el(
            "div",
            { class: "bar-row" },
            el("span", { class: "bl" }, site),
            el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${Math.round(((v.ok + v.fail) / max) * 100)}%` })),
            el("span", { class: "bn" }, String(v.ok + v.fail))
          )
        );
      }
      const card = el("div", { class: "stat wide" });
      card.append(el("div", { class: "lbl", style: "margin-bottom:6px" }, "Активность по сайтам (успех+ошибка)"), bars);
      box.append(card);
    }

    // по провайдерам
    const provs = new Map();
    for (const r of records) {
      if (!r.providerName) continue;
      provs.set(r.providerName, (provs.get(r.providerName) || 0) + 1);
    }
    if (provs.size) {
      const rows = [...provs.entries()].sort((a, b) => b[1] - a[1]);
      const max = Math.max(...rows.map(([, n]) => n));
      const bars = el("div", { class: "bars" });
      for (const [name, n] of rows) {
        bars.append(
          el(
            "div",
            { class: "bar-row" },
            el("span", { class: "bl" }, name),
            el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${Math.round((n / max) * 100)}%` })),
            el("span", { class: "bn" }, String(n))
          )
        );
      }
      const card = el("div", { class: "stat wide" });
      card.append(el("div", { class: "lbl", style: "margin-bottom:6px" }, "Записей по провайдерам"), bars);
      box.append(card);
    }
  }

  function statCard(num, lbl) {
    return el("div", { class: "stat" }, el("div", { class: "num" }, String(num)), el("div", { class: "lbl" }, lbl));
  }

  // --- init --------------------------------------------------------------------

  async function reload() {
    const s = await rpc("GET_STATE");
    state.records = s.records || [];
    state.settings = s.settings || {};
    state.providers = s.providers || { builtin: [], custom: [] };
    state.crypto = s.crypto || { enabled: false, unlocked: false };
  }

  function renderAll() {
    renderFill();
    renderVerify();
    renderReliability();
    renderProviders();
    renderSecurity();
    renderStats();
  }

  function wireNav() {
    for (const btn of document.querySelectorAll(".nav-item")) {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === btn.dataset.tab));
      });
    }
  }

  (async function init() {
    wireNav();
    wireProviders();
    wireData();
    try {
      await reload();
    } catch (e) {
      toast("Ошибка загрузки: " + e.message, false);
    }
    renderAll();
  })();
})();
