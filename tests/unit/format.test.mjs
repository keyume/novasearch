import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatClock, formatDay, formatWeekday } from '../../listen/js/format.js';

test('formatDuration', () => {
  assert.equal(formatDuration(812), '14 分钟');
  assert.equal(formatDuration(59), '1 分钟');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(3900), '1 小时 5 分钟');
  assert.equal(formatDuration(0), '0 分钟');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(undefined), '');
});

test('formatClock 用本地时间', () => {
  assert.equal(formatClock(new Date(2026, 10, 12, 8, 5).toISOString()), '08:05');
  assert.equal(formatClock(new Date(2026, 10, 12, 18, 30).toISOString()), '18:30');
  assert.equal(formatClock(null), '');
  assert.equal(formatClock('garbage'), '');
});

test('formatDay', () => {
  assert.equal(formatDay(new Date(2026, 10, 12, 8, 5).toISOString()), '11月12日');
  assert.equal(formatDay(new Date(2026, 0, 3, 23, 59).toISOString()), '1月3日');
  assert.equal(formatDay(null), '');
});

test('formatWeekday', () => {
  assert.equal(formatWeekday(new Date(2026, 10, 12)), '周四');
  assert.equal(formatWeekday(new Date(2026, 10, 15)), '周日');
});
