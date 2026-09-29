const content = document.querySelector('#content');
const bottomNav = document.querySelector('#bottom-nav');
const toast = document.querySelector('#toast');
const bridge = window.WebApp;
const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';

const app = {
  state: null,
  page: 'map',
  selectedTaskId: null,
  initData: bridge?.initData || (demoMode ? 'demo' : ''),
  backHandler: null,
};

const labels = {
  sex: { m: 'Мужчина', f: 'Женщина' },
  region: { moscow: 'Москва', other: 'Другой регион' },
  employment: { employee: 'По трудовому договору', other: 'Другое' },
  early: { no: 'Нет', yes: 'Да', unsure: 'Не знаю' },
  basis: { law: 'Закон', recommendation: 'Рекомендация сервиса', model: 'Справочные данные' },
};

function storedPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Настройка действует до закрытия приложения, если хранилище WebView недоступно.
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMonth(value) {
  if (!value) return 'Не рассчитано';
  return `${String(value.month).padStart(2, '0')}.${value.year}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function safeBridge(action) {
  try {
    const result = action();
    if (result?.catch) result.catch(() => {});
    return result;
  } catch {
    return null;
  }
}

function haptic(type = 'success') {
  safeBridge(() => bridge?.HapticFeedback?.notificationOccurred?.(type));
}

function setBackButton(visible) {
  if (!bridge?.BackButton) return;
  if (app.backHandler) safeBridge(() => bridge.BackButton.offClick(app.backHandler));
  app.backHandler = visible ? () => navigate('tasks') : null;
  if (app.backHandler) {
    safeBridge(() => bridge.BackButton.onClick(app.backHandler));
    safeBridge(() => bridge.BackButton.show());
  } else {
    safeBridge(() => bridge.BackButton.hide());
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'X-Max-Init-Data': app.initData,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Не удалось выполнить запрос.');
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function stateView(symbol, title, text, action = null) {
  content.innerHTML = `
    <section class="state-panel" aria-live="polite">
      <div class="state-symbol" aria-hidden="true">${escapeHtml(symbol)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(text)}</p>
      ${action ? `<button class="primary-button" type="button" id="state-action">${escapeHtml(action.label)}</button>` : ''}
    </section>`;
  bottomNav.hidden = true;
  if (action) document.querySelector('#state-action').addEventListener('click', action.run);
}

function renderMap() {
  const { calculation, progress, early_warning: earlyWarning } = app.state;
  const stateLabel = {
    not_yet: 'Период ещё не начался',
    in_window: 'Предпенсионный период идёт',
    right_reached: 'Дата права уже наступила',
  }[calculation.state];
  const percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  content.innerHTML = `
    <section class="hero">
      <p class="eyebrow">Моя карта</p>
      <h1>${escapeHtml(stateLabel)}</h1>
      <p>Расчёт ориентировочный. Точную дату и статус подтверждает справка Социального фонда России.</p>
      <div class="progress-wrap">
        <div class="progress-label"><span>Ваш прогресс</span><span>${progress.completed} из ${progress.total}</span></div>
        <progress class="progress-track" aria-label="Выполнение плана" max="100" value="${percent}">${percent}%</progress>
      </div>
    </section>
    ${earlyWarning ? `<aside class="notice"><span aria-hidden="true">!</span><p>${escapeHtml(earlyWarning)}</p></aside>` : ''}
    <section class="section" aria-labelledby="dates-title">
      <div class="section-heading"><div><p class="eyebrow">Ориентиры</p><h2 id="dates-title">Три важные даты</h2></div></div>
      <div class="card timeline">
        ${timelineItem('Начало предпенсионного периода', formatMonth(calculation.window_start), false)}
        ${timelineItem('Налоговая возрастная граница', formatMonth(calculation.tax_from), false)}
        ${timelineItem('Ориентировочная дата права', formatMonth(calculation.right), true)}
      </div>
    </section>
    <div class="button-row inline">
      <button class="primary-button" type="button" data-nav="tasks">Открыть шаги</button>
      <button class="secondary-button" type="button" id="share-plan">Поделиться картой</button>
    </div>`;
  document.querySelector('#share-plan').addEventListener('click', sharePlan);
}

function timelineItem(title, date, last) {
  return `<div class="timeline-item">
    <div class="timeline-rail"><span class="timeline-dot"></span>${last ? '' : '<span class="timeline-line"></span>'}</div>
    <div class="timeline-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(date)}</span></div>
  </div>`;
}

function taskBadge(task) {
  if (task.completed) return ['done', '✓ Готово'];
  if (task.availability === 'due') return ['', '● Сейчас'];
  return ['upcoming', '○ Позже'];
}

function renderTasks() {
  content.innerHTML = `
    <section>
      <p class="eyebrow">Личный план</p>
      <h1>Шаги</h1>
      <p class="section">Открывайте карточки по одной. Срочные шаги отмечены словом «Сейчас».</p>
      <div class="section" id="task-list">
        ${app.state.tasks.map((task) => {
          const [badgeClass, badgeText] = taskBadge(task);
          return `<button class="card task-card" type="button" data-task="${escapeHtml(task.id)}">
            <span class="task-card-head"><strong>${escapeHtml(task.title)}</strong><span class="badge ${badgeClass}">${badgeText}</span></span>
            <p>${escapeHtml(task.short)}</p>
          </button>`;
        }).join('')}
      </div>
    </section>`;
}

function renderTask() {
  const task = app.state.tasks.find((item) => item.id === app.selectedTaskId);
  if (!task) return navigate('tasks');
  const [badgeClass, badgeText] = taskBadge(task);
  content.innerHTML = `
    <button class="back-button" type="button" data-nav="tasks">← Назад к шагам</button>
    <article>
      <span class="badge ${badgeClass}">${badgeText}</span>
      <h1 class="section">${escapeHtml(task.title)}</h1>
      <p class="section">${escapeHtml(task.why)}</p>
      <section class="section card">
        <h2>Что сделать</h2>
        <ol class="detail-list">${task.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </section>
      ${task.documents?.length ? `<section class="section card"><h2>Что может понадобиться</h2><ul class="document-list">${task.documents.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><button class="text-link" type="button" id="copy-documents">Скопировать список документов</button></section>` : ''}
      ${task.say_to_employer ? `<section class="section card"><h2>Текст работодателю</h2><p class="section">${escapeHtml(task.say_to_employer)}</p><button class="secondary-button section" type="button" id="copy-employer">Скопировать текст</button></section>` : ''}
      ${task.extra_note ? `<aside class="notice"><span aria-hidden="true">i</span><p>${escapeHtml(task.extra_note)}</p></aside>` : ''}
      <div class="meta-grid">
        <div class="meta-item"><span>Происхождение</span><strong>${escapeHtml(labels.basis[task.basis] || task.basis)}</strong></div>
        <div class="meta-item"><span>Проверено</span><strong>${escapeHtml(task.source.checked)}</strong></div>
      </div>
      <div class="link-list">
        ${(task.channels || []).map((channel) => `<button class="text-link" type="button" data-link="${escapeHtml(channel.url)}">${escapeHtml(channel.label)} ↗</button>`).join('')}
        <button class="text-link" type="button" data-link="${escapeHtml(task.source.url)}">Источник: ${escapeHtml(task.source.title)} ↗</button>
      </div>
      <div class="button-row"><button class="primary-button" type="button" id="toggle-task">${task.completed ? 'Вернуть шаг' : 'Отметить как готово'}</button></div>
    </article>`;
  document.querySelector('#toggle-task').addEventListener('click', () => toggleTask(task));
  document.querySelector('#copy-documents')?.addEventListener('click', () => copyText(task.documents.join('\n'), 'Список скопирован'));
  document.querySelector('#copy-employer')?.addEventListener('click', () => copyText(task.say_to_employer, 'Текст скопирован'));
  document.querySelectorAll('[data-link]').forEach((button) => button.addEventListener('click', () => openLink(button.dataset.link)));
}

function profileForm(profile = {}) {
  return `<form class="form-grid" id="profile-form">
    <div class="field"><label for="sex">Пол</label><select id="sex" name="sex" required><option value="m" ${profile.sex === 'm' ? 'selected' : ''}>Мужчина</option><option value="f" ${profile.sex === 'f' ? 'selected' : ''}>Женщина</option></select></div>
    <div class="field"><label for="birth_ym">Месяц и год рождения</label><input id="birth_ym" name="birth_ym" type="month" value="${escapeHtml(profile.birth_ym || '1963-04')}" required><span class="field-hint">Храним только месяц и год.</span></div>
    <div class="field"><label for="region">Регион</label><select id="region" name="region"><option value="moscow" ${profile.region === 'moscow' ? 'selected' : ''}>Москва</option><option value="other" ${profile.region === 'other' ? 'selected' : ''}>Другой регион</option></select></div>
    <div class="field"><label for="employment">Занятость</label><select id="employment" name="employment"><option value="employee" ${profile.employment === 'employee' ? 'selected' : ''}>По трудовому договору</option><option value="other" ${profile.employment === 'other' ? 'selected' : ''}>Нет или другое</option></select></div>
    <div class="field"><label for="early">Право на досрочную пенсию</label><select id="early" name="early"><option value="no" ${profile.early === 'no' ? 'selected' : ''}>Нет</option><option value="yes" ${profile.early === 'yes' ? 'selected' : ''}>Да</option><option value="unsure" ${profile.early === 'unsure' ? 'selected' : ''}>Не знаю</option></select></div>
    <button class="primary-button" type="submit">Сохранить профиль</button>
  </form>`;
}

function renderProfile() {
  const profile = app.state.profile || {};
  content.innerHTML = `
    <section>
      <p class="eyebrow">Ваши данные</p>
      <h1>Профиль</h1>
      <p class="section">Эти сведения нужны только для ориентировочной карты.</p>
      <div class="card section">${profileForm(profile)}</div>
      ${profile.step === 'ready' ? `<section class="section"><h2>Сейчас в профиле</h2><div class="meta-grid"><div class="meta-item"><span>Регион</span><strong>${escapeHtml(labels.region[profile.region])}</strong></div><div class="meta-item"><span>Занятость</span><strong>${escapeHtml(labels.employment[profile.employment])}</strong></div><div class="meta-item"><span>Досрочная пенсия</span><strong>${escapeHtml(labels.early[profile.early])}</strong></div></div></section>` : ''}
      <section class="section"><h2>Удаление данных</h2><p class="section">Профиль, отметки и история будут удалены без восстановления.</p><button class="danger-button section" type="button" id="delete-profile">Удалить мои данные</button></section>
    </section>`;
  document.querySelector('#profile-form').addEventListener('submit', saveProfile);
  document.querySelector('#delete-profile').addEventListener('click', deleteProfile);
}

function render() {
  const hasProfile = app.state?.profile?.step === 'ready' && app.state.calculation;
  if (!hasProfile && app.page !== 'profile') {
    content.innerHTML = `<section class="state-panel"><div class="state-symbol" aria-hidden="true">○</div><h1>Карта ещё не настроена</h1><p>Заполните короткий профиль, чтобы увидеть ориентировочные даты и шаги.</p><button class="primary-button" type="button" data-nav="profile">Заполнить профиль</button></section>`;
  } else if (app.page === 'map') renderMap();
  else if (app.page === 'tasks') renderTasks();
  else if (app.page === 'task') renderTask();
  else renderProfile();
  bottomNav.hidden = false;
  bottomNav.querySelectorAll('button').forEach((button) => {
    const active = button.dataset.nav === app.page || (app.page === 'task' && button.dataset.nav === 'tasks');
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  setBackButton(app.page === 'task');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function navigate(page) {
  app.page = page;
  if (page !== 'task') app.selectedTaskId = null;
  window.location.hash = page;
  render();
  content.focus({ preventScroll: true });
}

async function refresh() {
  try {
    app.state = await api('/api/state');
    render();
  } catch (error) {
    const stale = error.code === 'auth_stale';
    stateView(stale ? '⌛' : '!', stale ? 'Сессия устарела' : 'Не удалось загрузить карту', error.message, stale ? null : { label: 'Повторить', run: refresh });
  }
}

async function toggleTask(task) {
  try {
    app.state = await api(`/api/tasks/${encodeURIComponent(task.id)}/status`, {
      method: 'POST', body: JSON.stringify({ status: task.completed ? 'todo' : 'done', period: task.period }),
    });
    haptic('success');
    showToast(task.completed ? 'Шаг возвращён' : 'Шаг отмечен');
    renderTask();
  } catch (error) {
    haptic('error');
    showToast(error.message);
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  try {
    app.state = await api('/api/profile', { method: 'POST', body: JSON.stringify(body) });
    haptic('success');
    showToast('Профиль сохранён');
    navigate('map');
  } catch (error) {
    haptic('error');
    showToast(error.message);
  }
}

async function deleteProfile() {
  if (!window.confirm('Удалить профиль, отметки и историю?')) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    app.state = { profile: null, calculation: null, tasks: [], progress: { completed: 0, total: 0 } };
    haptic('success');
    showToast('Данные удалены');
    navigate('profile');
  } catch (error) {
    showToast(error.message);
  }
}

async function copyText(text, successMessage) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'clipboard-helper';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    haptic('success');
    showToast(successMessage);
  } catch {
    showToast('Не удалось скопировать. Выделите текст вручную.');
  }
}

function openLink(url) {
  if (bridge?.openLink) safeBridge(() => bridge.openLink(url));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function sharePlan() {
  const text = `Пятилетка: личная карта подготовки к пенсии. Выполнено ${app.state.progress.completed} из ${app.state.progress.total}. Даты ориентировочные, их подтверждает СФР.`;
  void api('/api/events/share', { method: 'POST', body: '{}' }).catch(() => {});
  if (bridge?.shareContent && ['ios', 'android'].includes(bridge.platform)) {
    safeBridge(() => bridge.shareContent({ text }));
  } else {
    const url = `https://max.ru/:share?text=${encodeURIComponent(text)}`;
    if (bridge?.openMaxLink) safeBridge(() => bridge.openMaxLink(url));
    else window.location.href = url;
  }
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    event.preventDefault();
    navigate(nav.dataset.nav);
    return;
  }
  const task = event.target.closest('[data-task]');
  if (task) {
    app.selectedTaskId = task.dataset.task;
    app.page = 'task';
    render();
  }
});

document.querySelector('#font-toggle').addEventListener('click', () => {
  const large = document.documentElement.dataset.font !== 'large';
  document.documentElement.dataset.font = large ? 'large' : '';
  savePreference('font', large ? 'large' : 'normal');
});

document.querySelector('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  savePreference('theme', dark ? 'dark' : 'light');
});

document.documentElement.dataset.font = storedPreference('font') === 'large' ? 'large' : '';
const savedTheme = storedPreference('theme');
document.documentElement.dataset.theme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

if (!app.initData) {
  stateView('↗', 'Откройте из MAX', 'Мини-приложение получает безопасный доступ к вашей карте только при запуске из чата с ботом.');
} else {
  refresh();
}
