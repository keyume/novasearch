import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../../listen/js/stats.js';
import { CATALOG, CATEGORIES } from '../../listen/js/catalog.js';

const NOW = new Date(2026, 10, 12, 15, 0, 0);

test('今日与累计时长', () => {
  const s = summarize({ '2026-11-12': 300, '2026-11-01': 1200, '2025-01-01': 60 }, NOW);
  assert.equal(s.todaySec, 300);
  assert.equal(s.totalSec, 1560);
});

test('连续天数：今天达标时从今天算起', () => {
  const s = summarize({ '2026-11-12': 60, '2026-11-11': 500, '2026-11-10': 61 }, NOW);
  assert.equal(s.streak, 3);
});

test('连续天数：今天不足 60 秒时不打断到昨天为止的连续', () => {
  const s = summarize({ '2026-11-12': 10, '2026-11-11': 120, '2026-11-10': 120 }, NOW);
  assert.equal(s.streak, 2);
});

test('连续天数：中断后归零', () => {
  assert.equal(summarize({ '2026-11-10': 600, '2026-11-09': 600 }, NOW).streak, 0);
  assert.equal(summarize({ '2026-11-12': 600, '2026-11-10': 600 }, NOW).streak, 1);
  assert.equal(summarize({ '2026-11-11': 59 }, NOW).streak, 0);
});

test('连续天数：跨月', () => {
  const now = new Date(2026, 2, 1, 9, 0, 0);
  assert.equal(summarize({ '2026-03-01': 90, '2026-02-28': 90, '2026-02-27': 90 }, now).streak, 3);
});

test('last7 为 7 项、从旧到新、缺的天补 0', () => {
  const s = summarize({ '2026-11-12': 300, '2026-11-09': 90, '2026-11-01': 999 }, NOW);
  assert.deepEqual(s.last7, [
    { key: '2026-11-06', sec: 0 },
    { key: '2026-11-07', sec: 0 },
    { key: '2026-11-08', sec: 0 },
    { key: '2026-11-09', sec: 90 },
    { key: '2026-11-10', sec: 0 },
    { key: '2026-11-11', sec: 0 },
    { key: '2026-11-12', sec: 300 },
  ]);
});

test('空数据与无效数据', () => {
  assert.deepEqual(summarize({}, NOW).streak, 0);
  assert.equal(summarize(undefined, NOW).totalSec, 0);
  assert.equal(summarize({ '2026-11-12': 'x', junk: NaN }, NOW).todaySec, 0);
});

test('catalog：id 唯一、地址是 https、类别合法、有默认订阅', () => {
  assert.equal(new Set(CATALOG.map((s) => s.id)).size, CATALOG.length);
  assert.equal(new Set(CATALOG.map((s) => s.feedUrl)).size, CATALOG.length);
  for (const s of CATALOG) {
    assert.match(s.feedUrl, /^https:\/\//, s.id);
    assert.ok(CATEGORIES.includes(s.category), s.id);
    for (const field of ['id', 'title', 'source', 'blurb', 'length']) {
      assert.ok(typeof s[field] === 'string' && s[field].length > 0, `${s.id}.${field}`);
    }
    assert.equal(typeof s.default, 'boolean', s.id);
    assert.match(s.id, /^[a-z0-9-]+$/);
  }
  assert.ok(CATALOG.some((s) => s.default));
  for (const category of CATEGORIES) assert.ok(CATALOG.some((s) => s.category === category), category);
});
