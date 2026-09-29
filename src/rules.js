import { readFileSync } from 'node:fs';
import { computePensionStatus } from './pension-age.js';

const RULES_URL = new URL('../data/rules.json', import.meta.url);
const REGIONS_URL = new URL('../data/regions.json', import.meta.url);

function readJson(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
}

export function loadRulesData({ rulesPath = RULES_URL, regionsPath = REGIONS_URL } = {}) {
  return {
    rules: readJson(rulesPath),
    regions: readJson(regionsPath),
  };
}

function validateProfile(profile, regions) {
  if (!profile || !['m', 'f'].includes(profile.sex)) throw new RangeError('Некорректный пол');
  if (!Number.isInteger(profile.birthYear) || !Number.isInteger(profile.birthMonth)) {
    throw new RangeError('Некорректный месяц рождения');
  }
  if (!regions.regions[profile.region]) throw new RangeError('Неизвестный регион');
  if (!['employee', 'other'].includes(profile.employment)) throw new RangeError('Некорректная занятость');
  if (!['no', 'yes', 'unsure'].includes(profile.early)) throw new RangeError('Некорректный признак досрочной пенсии');
}

function taskApplies(task, profile) {
  return Object.entries(task.applies ?? {}).every(([field, allowed]) => (
    Array.isArray(allowed) && allowed.includes(profile[field])
  ));
}

function mergeTask(task, region) {
  const override = region.task_overrides?.[task.id];
  if (!override) return structuredClone(task);
  return {
    ...structuredClone(task),
    ...structuredClone(override),
    source: override.source ? structuredClone(override.source) : structuredClone(task.source),
  };
}

function triggerState(task, calculation) {
  const offset = task.trigger.offset_months ?? 0;

  switch (task.trigger.type) {
    case 'now':
      return { available: true, monthsUntil: 0 };
    case 'window_start':
      return {
        available: calculation.months_to_window <= -offset,
        monthsUntil: calculation.months_to_window + offset,
      };
    case 'tax_from':
      return {
        available: calculation.tax_active,
        monthsUntil: calculation.months_to_tax,
      };
    case 'months_before_right':
      return {
        available: calculation.months_to_right <= offset,
        monthsUntil: calculation.months_to_right - offset,
      };
    default:
      throw new RangeError(`Неизвестный тип триггера: ${task.trigger.type}`);
  }
}

function stateKey(task, now) {
  return task.kind === 'annual' ? String(now.year) : '';
}

function isCompleted(task, now, taskStates) {
  const period = stateKey(task, now);
  return taskStates.some((item) => (
    item.task_id === task.id
    && String(item.period ?? '') === period
    && item.status === 'done'
  ));
}

export function buildPlan({
  profile,
  now,
  taskStates = [],
  data = loadRulesData(),
}) {
  validateProfile(profile, data.regions);
  const calculation = computePensionStatus(profile, now);
  const region = data.regions.regions[profile.region];

  const tasks = data.rules.tasks
    .filter((task) => taskApplies(task, profile))
    .map((task) => mergeTask(task, region))
    .map((task) => {
      const trigger = triggerState(task, calculation);
      const completed = isCompleted(task, now, taskStates);
      return {
        ...task,
        period: stateKey(task, now),
        completed,
        availability: completed ? 'done' : trigger.available ? 'due' : 'upcoming',
        months_until_available: Math.max(0, trigger.monthsUntil),
      };
    })
    .sort((left, right) => left.priority - right.priority);

  const completedCount = tasks.filter((task) => task.completed).length;

  return {
    rules_version: data.rules.version,
    disclaimer: data.rules.disclaimer,
    region: { id: profile.region, label: region.label },
    early_warning: profile.early === 'no'
      ? null
      : 'При досрочной пенсии даты рассчитываются иначе. Уточните дату и статус в СФР.',
    calculation,
    tasks,
    progress: { completed: completedCount, total: tasks.length },
  };
}
