import { Keyboard } from '@maxhub/max-bot-api';

const callback = Keyboard.button.callback;

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

function rows(buttons, size = 2) {
  const result = [];
  for (let index = 0; index < buttons.length; index += size) {
    result.push(buttons.slice(index, index + size));
  }
  return result;
}

export function welcomeView() {
  return {
    text: [
      'Пятилетка помогает подготовиться к пенсии заранее.',
      'Даты ориентировочные. Точную дату и статус подтверждает Социальный фонд России.',
      'Мы не видим данные Госуслуг и не считаем размер пенсии.',
    ].join('\n\n'),
    buttons: [[callback('Составить план', 'setup:start')]],
  };
}

export function sexView() {
  return {
    text: 'Укажите пол. Он нужен только для ориентировочного расчёта возраста.',
    buttons: [[callback('Мужчина', 'setup:sex:m'), callback('Женщина', 'setup:sex:f')]],
  };
}

export function birthYearView() {
  const years = Array.from({ length: 17 }, (_, index) => 1959 + index);
  return {
    text: 'Выберите год рождения. Если года нет, нажмите «Ввести месяц и год».',
    buttons: [
      ...rows(years.map((year) => callback(String(year), `setup:by:${year}`)), 3),
      [callback('Ввести месяц и год', 'setup:birth:custom')],
    ],
  };
}

export function birthMonthView() {
  return {
    text: 'Выберите месяц рождения.',
    buttons: rows(MONTHS.map((month, index) => callback(month, `setup:bm:${index + 1}`)), 2),
  };
}

export function customBirthView(error = null) {
  let text = 'Введите месяц и год рождения в формате ММ.ГГГГ, например 04.1963.';
  if (error === 'format') {
    text = 'Не получилось прочитать дату. Введите месяц и год в формате ММ.ГГГГ, например 04.1963.';
  } else if (error === 'range') {
    text = 'Укажите реальный месяц и год рождения. Сервис рассчитан на возраст от 40 до 100 лет.';
  }
  return {
    text,
    buttons: [],
  };
}

export function regionView() {
  return {
    text: 'Выберите регион. Сейчас отдельный пакет подготовлен для Москвы.',
    buttons: [[
      callback('Москва', 'setup:region:moscow'),
      callback('Другой регион', 'setup:region:other'),
    ]],
  };
}

export function employmentView() {
  return {
    text: 'Вы работаете по трудовому договору?',
    buttons: [[
      callback('Да', 'setup:emp:employee'),
      callback('Нет или другое', 'setup:emp:other'),
    ]],
  };
}

export function earlyView() {
  return {
    text: 'Есть право на досрочную пенсию?',
    buttons: [
      [callback('Нет', 'setup:early:no')],
      [callback('Да', 'setup:early:yes'), callback('Не знаю', 'setup:early:unsure')],
    ],
  };
}

function formatMonth(value) {
  return `${String(value.month).padStart(2, '0')}.${value.year}`;
}

const stateLabels = {
  not_yet: 'Предпенсионный период ещё не начался',
  in_window: 'Предпенсионный период ориентировочно идёт',
  right_reached: 'Ориентировочная дата права уже наступила',
};

export function datesView(plan) {
  return {
    text: [
      stateLabels[plan.calculation.state],
      `Начало предпенсионного периода: ${formatMonth(plan.calculation.window_start)}`,
      `Налоговая граница: ${formatMonth(plan.calculation.tax_from)}`,
      `Ориентировочная дата права: ${formatMonth(plan.calculation.right)}`,
      '',
      'Точную дату и статус подтверждает справка Социального фонда России.',
    ].join('\n'),
    buttons: [[callback('Что делать сейчас', 'nav:now'), callback('Весь план', 'nav:plan')]],
  };
}

export function planView(plan, { botUsername = '', miniappEnabled = false } = {}) {
  const taskLines = plan.tasks.map((task, index) => {
    const mark = task.completed ? 'Готово' : task.availability === 'due' ? 'Сейчас' : 'Позже';
    return `${index + 1}. [${mark}] ${task.title}`;
  });
  const buttons = plan.tasks.map((task) => [callback(task.title, `nav:task:${task.id}`)]);
  let hasOpenApp = false;
  if (miniappEnabled && botUsername) {
    buttons.push([Keyboard.button.openApp('Открыть мою карту', botUsername, undefined, 'plan')]);
    hasOpenApp = true;
  }
  buttons.push([callback('Что делать сейчас', 'nav:now'), callback('Даты', 'nav:dates')]);

  return {
    text: [
      `Личная карта: выполнено ${plan.progress.completed} из ${plan.progress.total}.`,
      plan.early_warning ?? '',
      ...taskLines,
      '',
      'Даты ориентировочные. Официальный статус подтверждает СФР.',
    ].filter(Boolean).join('\n'),
    buttons,
    hasOpenApp,
  };
}

export function nowView(plan) {
  const due = plan.tasks.filter((task) => task.availability === 'due');
  const text = due.length > 0
    ? ['Сейчас стоит сделать:', ...due.map((task, index) => `${index + 1}. ${task.short}`)].join('\n')
    : 'Срочных шагов сейчас нет. Можно открыть весь план и подготовиться заранее.';
  return {
    text,
    buttons: [
      ...due.map((task) => [callback(task.title, `nav:task:${task.id}`)]),
      [callback('Весь план', 'nav:plan'), callback('Даты', 'nav:dates')],
    ],
  };
}

export function taskView(task) {
  const sourceLabel = task.basis === 'law'
    ? 'Основание: закон'
    : task.basis === 'recommendation'
      ? 'Основание: рекомендация'
      : 'Основание: справочные данные';
  const text = [
    task.title,
    task.why,
    '',
    ...task.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    sourceLabel,
    `Проверено: ${task.source.checked}`,
    task.safety_note ?? '',
  ].filter(Boolean).join('\n');
  const buttons = [[
    callback(task.completed ? 'Вернуть' : 'Готово', `${task.completed ? 'task:undo' : 'task:done'}:${task.id}`),
    callback('Назад к плану', 'nav:plan'),
  ]];
  if (task.source?.url) buttons.push([Keyboard.button.link('Открыть источник', task.source.url)]);
  if (task.say_to_employer) {
    buttons.push([Keyboard.button.clipboard('Скопировать текст работодателю', task.say_to_employer)]);
  }
  return { text: text.slice(0, 3900), buttons };
}

export function sourcesView(plan) {
  const unique = new Map();
  for (const task of plan.tasks) unique.set(task.source.url, task.source.title);
  return {
    text: ['Источники плана:', ...[...unique.values()].map((title, index) => `${index + 1}. ${title}`)].join('\n'),
    buttons: [[callback('Вернуться к плану', 'nav:plan')]],
  };
}

export function helpView() {
  return {
    text: [
      'Команды:',
      '/plan - весь план',
      '/now - что сделать сейчас',
      '/dates - ориентировочные даты',
      '/sources - источники',
      '/reset - удалить данные',
      '/id - диагностический ID',
    ].join('\n'),
    buttons: [[callback('Начать настройку', 'setup:start')]],
  };
}

export function resetView() {
  return {
    text: 'Удалить профиль, отметки и историю событий? Это действие нельзя отменить.',
    buttons: [[callback('Удалить мои данные', 'reset:yes'), callback('Отмена', 'nav:plan')]],
  };
}

export function staleView() {
  return {
    text: 'Эта кнопка устарела. Продолжите с текущего шага или отправьте /start.',
    buttons: [],
  };
}

export function noProfileView() {
  return {
    text: 'Сначала ответьте на несколько вопросов. Это займёт около минуты.',
    buttons: [[callback('Начать', 'setup:start')]],
  };
}

export function fallbackView() {
  return {
    text: 'Не понял сообщение. Используйте кнопки или команду /help.',
    buttons: [[callback('Помощь', 'nav:help')]],
  };
}
