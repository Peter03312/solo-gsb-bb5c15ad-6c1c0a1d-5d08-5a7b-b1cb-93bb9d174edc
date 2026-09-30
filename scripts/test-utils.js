'use strict';

/* 不依赖数据库的核心算法自测：node scripts/test-utils.js */

const assert = require('assert');
const dosing = require('../src/dosing');
const { parsePeriods, ValidationError } = require('../src/validation');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// 1) 时段解析与跨午夜
test('跨午夜时段 20:00-02:00 时长 6 小时', () => {
  const [p] = parsePeriods(['20:00-02:00']);
  assert.strictEqual(p.startMin, 1200);
  assert.strictEqual(p.durationMin, 360);
});
test('零时长时段被拒绝', () => {
  assert.throws(() => parsePeriods(['09:00-09:00']), ValidationError);
});
test('非法时间格式被拒绝', () => {
  assert.throws(() => parsePeriods(['9:00-10:00']), ValidationError);
  assert.throws(() => parsePeriods(['25:00-26:00']), ValidationError);
});
test('同日重叠时段被拒绝（跨午夜撞次日早段）', () => {
  assert.throws(() => parsePeriods(['20:00-02:00', '01:00-03:00']), ValidationError);
});
test('不重叠的多时段通过', () => {
  const ps = parsePeriods(['09:00-12:00', '13:00-17:00']);
  assert.strictEqual(ps.length, 2);
});

// 2) 按自然年拆分
test('单日 8 小时 100lx = 800 lx·h', () => {
  const w = dosing.buildWindows('2026-03-01', '2026-03-01', parsePeriods(['09:00-17:00']));
  const by = dosing.doseByYear(w, 100);
  assert.strictEqual(by.get(2026), 800);
});

test('跨年展期按墙上自然年拆分', () => {
  // 2026-12-31 ~ 2027-01-01，每天 8h，100lx => 每年各 800
  const w = dosing.buildWindows('2026-12-31', '2027-01-01', parsePeriods(['09:00-17:00']));
  const by = dosing.doseByYear(w, 100);
  assert.strictEqual(by.get(2026), 800);
  assert.strictEqual(by.get(2027), 800);
});

test('年界当天跨午夜开灯按时段分钟切年（+08:00，02:00 属次年 2h）', () => {
  // 2026-12-31 22:00 -> 2027-01-01 02:00（墙上）：2026 占 2h，2027 占 2h
  const w = dosing.buildWindows('2026-12-31', '2026-12-31', parsePeriods(['22:00-02:00']));
  const by = dosing.doseByYear(w, 100);
  assert.strictEqual(by.get(2026), 200);
  assert.strictEqual(by.get(2027), 200);
});

// 3) 实测替代估算：区间扣除
test('实测窗从计划窗扣除后仅剩剩余区间', () => {
  const all = dosing.buildWindows('2026-03-01', '2026-03-02', parsePeriods(['09:00-17:00']));
  const hole = [{ start: dosing.wallToTs('2026-03-01', 9 * 60), end: dosing.wallToTs('2026-03-01', 17 * 60) }];
  const rest = dosing.subtractIntervals(all, hole);
  // 只剩 3/2 的 8 小时
  const totalMin = rest.reduce((s, x) => s + (x.end - x.start) / 60000, 0);
  assert.strictEqual(totalMin, 480);
});

// 4) 时间重叠判断（左闭右开，相接不重叠）
test('相接区间不算重叠，相交才算', () => {
  const t1 = new Date('2026-03-01T01:00:00Z').getTime();
  const t2 = new Date('2026-03-01T09:00:00Z').getTime();
  assert.strictEqual(dosing.intersects({ start: t1, end: t2 }, { start: t2, end: t2 + 1 }), false);
  assert.strictEqual(dosing.intersects({ start: t1, end: t2 + 1 }, { start: t2, end: t2 + 2 }), true);
});

// 5) 实测必须被计划窗包含
test('包含判断：严格在内/越界', () => {
  const outer = { start: 100, end: 200 };
  assert.strictEqual(dosing.containsInterval(outer, { start: 100, end: 200 }), true);
  assert.strictEqual(dosing.containsInterval(outer, { start: 99, end: 150 }), false);
  assert.strictEqual(dosing.containsInterval(outer, { start: 150, end: 201 }), false);
});

console.log(`\n全部 ${passed} 项算法测试通过。`);
