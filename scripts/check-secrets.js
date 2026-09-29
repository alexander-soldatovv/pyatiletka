import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const skippedDirs = new Set(['.git', 'node_modules', 'coverage', 'tmp']);
const skippedExtensions = new Set(['.cer', '.crt', '.db', '.jpg', '.jpeg', '.pdf', '.pem', '.png', '.sqlite']);
const skippedFiles = new Set(['package-lock.json']);
const findings = [];

function placeholder(value) {
  const normalized = value.toLowerCase();
  return !value
    || /^(replace|test|mock|local|demo|example|changeme|your|sample|dummy|placeholder)/.test(normalized)
    || value.startsWith('<')
    || value.startsWith('${')
    || value.startsWith('$')
    || /[+*^\\]/u.test(value);
}

function report(source, lineNumber, rule) {
  findings.push(`${source}:${lineNumber}: ${rule}`);
}

function scanLine(line, source, lineNumber) {
  const assignment = /\b(BOT_TOKEN|ADMIN_TOKEN|WEBHOOK_SECRET|EVENT_SALT)\s*=\s*["']?([^\s"'`#,;]+)/giu;
  for (const match of line.matchAll(assignment)) {
    if (!placeholder(match[2])) report(source, lineNumber, `${match[1]} содержит непустое значение`);
  }
  const yamlAssignment = /^\s*["']?(BOT_TOKEN|ADMIN_TOKEN|WEBHOOK_SECRET|EVENT_SALT)["']?\s*:\s*["']?([^\s"'`#,;]+)/iu.exec(line);
  if (yamlAssignment && !placeholder(yamlAssignment[2])) {
    report(source, lineNumber, `${yamlAssignment[1]} содержит непустое значение`);
  }

  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u.test(line)) {
    report(source, lineNumber, 'обнаружена JWT-подобная строка');
  }

  const contextual = /\b(token|secret|authorization|api[_ -]?key)\b[^\n]{0,24}?([A-Za-z0-9._~-]{32,})/giu;
  for (const match of line.matchAll(contextual)) {
    if (!placeholder(match[2])) report(source, lineNumber, 'обнаружена длинная токеноподобная строка');
  }
}

function scanText(text, source, history = false) {
  let currentFile = source;
  let logicalLine = 0;
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    if (history && rawLine.startsWith('+++ b/')) {
      currentFile = `git-history:${rawLine.slice(6)}`;
      continue;
    }
    if (history) {
      if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
      logicalLine += 1;
      scanLine(rawLine.slice(1), currentFile, logicalLine);
    } else {
      scanLine(rawLine, currentFile, index + 1);
    }
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const local = relative(root, path);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (skippedDirs.has(entry) || entry.startsWith('tmp-cert-check.')) continue;
      walk(path);
      continue;
    }
    if (skippedFiles.has(entry) || skippedExtensions.has(extname(entry).toLowerCase()) || info.size > 1_000_000) continue;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) continue;
    scanText(text, local);
  }
}

walk(root);

let history;
try {
  history = execFileSync('git', [
    'log', '-p', '--all', '--no-ext-diff', '--format=commit %H', '--', '.',
    ':(exclude)package-lock.json', ':(exclude)docs/case.pdf', ':(exclude)certs',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  console.error(`Не удалось проверить git-историю: ${error.message}`);
  process.exit(1);
}
scanText(history, 'git-history', true);

const unique = [...new Set(findings)];
if (unique.length > 0) {
  console.error('Проверка секретов не пройдена. Значения намеренно не выводятся:');
  for (const finding of unique) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Секреты: явные значения и длинные токеноподобные строки не найдены в файлах и git-истории.');
