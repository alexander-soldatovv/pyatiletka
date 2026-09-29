import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DATA_ROOT = new URL('../data/', import.meta.url);
const ALLOWED_BASIS = new Set(['law', 'recommendation', 'model']);
const ALLOWED_KINDS = new Set(['one_time', 'annual', 'milestone']);
const ALLOWED_TRIGGERS = new Set(['now', 'window_start', 'months_before_right', 'tax_from']);

function readJson(name) {
  return JSON.parse(readFileSync(new URL(name, DATA_ROOT), 'utf8'));
}

function walkStrings(value, path, errors) {
  if (typeof value === 'string') {
    if (value.includes('\u2014')) errors.push(`${path}: найден U+2014`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkStrings(item, `${path}.${key}`, errors);
  }
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validateSource(source, path, errors) {
  if (!source || typeof source !== 'object') {
    errors.push(`${path}: нет source`);
    return;
  }
  if (!source.title) errors.push(`${path}.title: обязательное поле`);
  if (!isHttpUrl(source.url)) errors.push(`${path}.url: нужен http(s) URL`);
  if (!isDate(source.checked)) errors.push(`${path}.checked: нужна дата YYYY-MM-DD`);
  if (!source.quality) errors.push(`${path}.quality: обязательное поле`);
}

export function validateData({ rules, regions, pensionAge, testvectors }) {
  const errors = [];
  for (const [name, value] of Object.entries({ rules, regions, pensionAge, testvectors })) {
    walkStrings(value, name, errors);
  }

  if (!Array.isArray(rules?.tasks) || rules.tasks.length === 0) {
    errors.push('rules.tasks: нужен непустой массив');
  }

  const ids = new Set();
  for (const [index, task] of (rules?.tasks ?? []).entries()) {
    const path = `rules.tasks[${index}]`;
    for (const field of ['id', 'title', 'why']) {
      if (typeof task[field] !== 'string' || task[field].length === 0) errors.push(`${path}.${field}: обязательное поле`);
    }
    if (ids.has(task.id)) errors.push(`${path}.id: дубликат ${task.id}`);
    ids.add(task.id);
    if (!ALLOWED_KINDS.has(task.kind)) errors.push(`${path}.kind: неизвестное значение`);
    if (!ALLOWED_BASIS.has(task.basis)) errors.push(`${path}.basis: неизвестное значение`);
    if (!task.trigger || !ALLOWED_TRIGGERS.has(task.trigger.type)) errors.push(`${path}.trigger: неизвестный тип`);
    if (!Number.isInteger(task.trigger?.offset_months)) errors.push(`${path}.trigger.offset_months: нужно целое число`);
    validateSource(task.source, `${path}.source`, errors);
    for (const [channelIndex, channel] of (task.channels ?? []).entries()) {
      if (!channel.label || !isHttpUrl(channel.url)) errors.push(`${path}.channels[${channelIndex}]: некорректный канал`);
    }
  }

  if (!regions?.regions || typeof regions.regions !== 'object') errors.push('regions.regions: нужен объект');
  for (const [regionId, region] of Object.entries(regions?.regions ?? {})) {
    if (!region.label) errors.push(`regions.${regionId}.label: обязательное поле`);
    for (const [taskId, override] of Object.entries(region.task_overrides ?? {})) {
      if (!ids.has(taskId)) errors.push(`regions.${regionId}: неизвестный task_id ${taskId}`);
      for (const [channelIndex, channel] of (override.channels ?? []).entries()) {
        if (!channel.label || !isHttpUrl(channel.url)) {
          errors.push(`regions.${regionId}.${taskId}.channels[${channelIndex}]: некорректный канал`);
        }
      }
      if (override.source) validateSource(override.source, `regions.${regionId}.${taskId}.source`, errors);
    }
  }

  validateSource(pensionAge?.source, 'pension_age.source', errors);
  if (!Number.isInteger(pensionAge?.pre_pension_window_months)) {
    errors.push('pension_age.pre_pension_window_months: нужно целое число');
  }

  const vectorKeys = new Set();
  for (const [index, vector] of (testvectors?.vectors ?? []).entries()) {
    const key = `${vector.sex}:${vector.birth_year}`;
    if (vectorKeys.has(key)) errors.push(`testvectors.vectors[${index}]: дубликат ${key}`);
    vectorKeys.add(key);
    if (!['m', 'f'].includes(vector.sex) || !Number.isInteger(vector.birth_year) || !Number.isInteger(vector.expected_age_months)) {
      errors.push(`testvectors.vectors[${index}]: некорректный вектор`);
    }
  }

  return errors;
}

export function loadAndValidateData() {
  const data = {
    rules: readJson('rules.json'),
    regions: readJson('regions.json'),
    pensionAge: readJson('pension_age.json'),
    testvectors: readJson('testvectors.json'),
  };
  return validateData(data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = loadAndValidateData();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Данные прошли проверку.');
  }
}

