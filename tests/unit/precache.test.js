import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function toEntry(relativePath) {
  return `./${relativePath.split(path.sep).join('/')}`;
}

function readAppShell() {
  const sw = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const block = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js 中找不到 APP_SHELL');
  const entries = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(entries.length > 20, 'APP_SHELL 条目过少');
  return entries;
}

function walkJs(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walkJs(full));
    else if (name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('Service Worker 预缓存文件全部存在且无重复', () => {
  const entries = readAppShell();
  assert.equal(new Set(entries).size, entries.length, 'APP_SHELL 存在重复条目');
  assert.ok(entries.includes('./'), '缺少根路径');
  assert.ok(entries.includes('./index.html'), '缺少 index.html');

  for (const entry of entries) {
    const target = path.join(ROOT, entry);
    assert.ok(existsSync(target), `预缓存文件不存在：${entry}`);
  }
});

test('所有本地 JS 静态 import 都被预缓存', () => {
  const entries = new Set(readAppShell());
  const jsFiles = walkJs(path.join(ROOT, 'js'));
  for (const file of jsFiles) {
    const source = readFileSync(file, 'utf8');
    const imports = [
      ...source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g),
      ...source.matchAll(/import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);

    for (const specifier of imports) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(ROOT, resolved);
      assert.ok(
        entries.has(toEntry(relative)),
        `${path.relative(ROOT, file)} 导入的 ${specifier} 未预缓存`,
      );
    }
  }
});

test('index.html 引用的本地资源都被预缓存', () => {
  const entries = new Set(readAppShell());
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(refs.length >= 4, 'index.html 本地资源引用过少');
  for (const ref of refs) {
    assert.ok(entries.has(ref), `index.html 引用的 ${ref} 未预缓存`);
  }
});

test('manifest 图标文件存在且为 PNG', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'),
  );
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  for (const icon of manifest.icons) {
    const iconPath = path.join(ROOT, icon.src);
    assert.ok(existsSync(iconPath), `manifest 图标不存在：${icon.src}`);
    finalBytes(iconPath);
  }

  function finalBytes(iconPath) {
    const bytes = readFileSync(iconPath);
    assert.equal(bytes[0], 0x89, `${iconPath} 不是 PNG`);
    assert.equal(bytes[1], 0x50, `${iconPath} 不是 PNG`);
  }
});
