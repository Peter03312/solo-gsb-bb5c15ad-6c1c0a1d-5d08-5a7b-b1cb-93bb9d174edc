'use strict';

/*
 * 基于 pg-mem 的端到端业务流程测试（不依赖真实 PostgreSQL）：
 *   node scripts/test-integration.js
 * 覆盖：登记额度、提交/批准、重叠拒绝、超限按年超额量、并发批准不超配、
 *       实测替代估算、重叠实测拒绝、迟到实测转待复核与复核重新校验、
 *       计划调整申请的提交/撤回/驳回/批准、待审占用、原值拟改值、冲突计划/实测/超额年份核对、
 *       下调年度上限的预演/凭证提交、占用变化拒绝并返回新结果、旧接口同事务即时重算、
 *       未开始计划转待复核（写明原因）、已开始计划保留且超额如实显示。
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

// ---- 用 pg-mem 替换 pg 连接池 ----
const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

// db.js 的 withTransaction 使用 pool.connect() 取得 client；其余处使用 pool.query。
dbModule.pool.connect = (...args) => fakePool.connect(...args);
dbModule.pool.query = (...args) => fakePool.query(...args);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');

let server;
let base;
const cookies = new Map();
let assertCount = 0;

function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error('断言失败: ' + msg);
}

// pg-mem 的 DATE 可能返回 Date 对象，真实 pg 经类型解析返回 'YYYY-MM-DD'；统一取前 10 位
function ymd(v) {
  return typeof v === 'string' ? v.slice(0, 10)
    : `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* ignore */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await runFlow();

  server.close();
  console.log(`\n集成测试全部通过（${assertCount} 条断言）`);
  process.exit(0);
}

async function runFlow() {
  // ---- 登录 / 角色 ----
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  assert(r.status === 200, '保管员登录');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  assert(r.status === 200, '布展员登录');

  r = await call('POST', '/api/exhibits', { name: 'X' }, 'i');
  assert(r.status === 403, '布展员不能登记展品');

  // ---- 登记展品与额度 ----
  r = await call('POST', '/api/exhibits',
    { name: '宋拓本', accessionNo: 'A-1', medium: '纸本' }, 'c');
  assert(r.status === 201, '登记展品');
  const exhibitId = r.body.exhibit.id;

  r = await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 1600 }, 'c');
  assert(r.status === 200, '登记 2026 上限 1600');

  // ---- 输入校验 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏计划', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['09:00-17:00'], estimatedLux: 0,
  }, 'i');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正照度报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏时段', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-09:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '零时长时段报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏日期', startDate: '2026-02-30', endDate: '2026-03-02',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '非法日期报错');

  // ---- 计划1：3/1-3/2 每天 09-17，100lx = 1600 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '三月展', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交计划1');
  const plan1 = r.body.plan.id;

  r = await call('GET', `/api/plans/${plan1}`, null, 'i');
  assert(r.body.estimatedYearly['2026'] === 1600, '按年拆分 2026=1600');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'i');
  assert(r.status === 403, '布展员不能批准');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'c');
  assert(r.status === 200, '保管员批准计划1');

  // ---- 夜场：同日但不重叠；额度不足 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '夜场（不重叠）', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['18:00-22:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '非重叠时段可提交');
  const plan2 = r.body.plan.id;
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 409 && r.body.details.overflows[0].year === 2026,
    '夜场批准因 2026 超限被拒');
  const ov = r.body.details.overflows[0];
  assert(ov.excess === 400 && ov.limit === 1600 && ov.projected === 2000,
    `超额量 400 正确，实际=${JSON.stringify(ov)}`);

  // ---- 时间重叠计划：提交即被拒 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '撞车计划', startDate: '2026-03-02', endDate: '2026-03-02',
    periods: ['10:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '重叠计划提交即被拒');

  // 提额到 3000 后夜场可批（1600+400=2000）
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 3000 }, 'c');
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 200, '提额后夜场批准成功');

  // ---- 实测：3/1 实测 150lx 替代当天 100lx 估算 ----
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '09:00',
    endDate: '2026-03-01', endTime: '17:00', actualLux: 150,
  }, 'c');
  assert(r.status === 201, '录入实测草稿');
  const meas1 = r.body.measurement.id;

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '17:30',
    endDate: '2026-03-01', endTime: '18:30', actualLux: 100,
  }, 'c');
  assert(r.status === 400, '计划开灯窗外的实测被拒绝');

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '10:00',
    endDate: '2026-03-01', endTime: '11:00', actualLux: 100,
  }, 'c');
  assert(r.status === 409, '重叠实测被拒绝');

  r = await call('POST', `/api/measurements/${meas1}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（不超限）');
  // 1200(实测) + 800(plan1 次日残余) + 400(夜场) = 2400
  assert(r.body.years['2026'].used === 2400,
    `实测替代估算后 2026 已用应为 2400，实际 ${r.body.years['2026'].used}`);
  assert(r.body.years['2026'].remaining === 600, '剩余 600');

  // ---- 迟到实测导致超限 + 转待复核 ----
  // 另一年份（约 400 天后）的已批准计划，用于验证“别的年份超额不会牵连它”
  const future = new Date(Date.now() + 400 * 86400000);
  const fy = future.getUTCFullYear();
  const fm = String(future.getUTCMonth() + 1).padStart(2, '0');
  const fd = String(future.getUTCDate()).padStart(2, '0');
  const futureYmd = `${fy}-${fm}-${fd}`;
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: fy, limitLxh: 2000 }, 'c');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '未来展（另一年份）', startDate: futureYmd, endDate: futureYmd,
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交另一年份未来计划');
  const futurePlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${futurePlan}/approve`, {}, 'c');
  assert(r.status === 200, '另一年份未来计划批准');

  // 2026 年内、确定尚未开始的计划（必须在迟到实测确认前批准）
  const in30 = new Date(Date.now() + 30 * 86400000);
  let pendingPlan = null;
  if (in30.getUTCFullYear() === 2026) {
    const m2 = String(in30.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(in30.getUTCDate()).padStart(2, '0');
    const ymd2 = `2026-${m2}-${d2}`;
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: '2026未开始计划', startDate: ymd2, endDate: ymd2,
      periods: ['09:00-17:00'], estimatedLux: 50, // 8h*50 = 400
    }, 'i');
    assert(cr.status === 201, '提交 2026 未开始计划');
    pendingPlan = cr.body.plan.id;
    // 当前 used=2400，+400=2800 ≤ 3000
    const ar = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(ar.status === 200, `2026 未开始计划批准（实际 ${ar.status} ${JSON.stringify(ar.body)}）`);
  }

  // 迟到实测：plan1 第二天 3/2 实测 500lx => 4000 替代 800
  // 2026 used = 1200 + 4000 + 400(夜场) [+ 400 待复核计划] = 6000，超额 3000
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '17:00', actualLux: 500,
  }, 'c');
  assert(r.status === 201, '录入迟到实测草稿');
  const meas2 = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${meas2}/confirm`, {}, 'c');
  assert(r.status === 409, '迟到实测确认后超限返回 409');
  const of2026 = r.body.overflows.find((o) => o.year === 2026);
  assert(of2026 && of2026.excess === 3000 && of2026.projected === 6000,
    `2026 超额 3000、合计 6000，实际=${JSON.stringify(r.body.overflows)}`);
  // 另一年份的计划不受牵连
  assert(!r.body.flaggedPlans.some((p) => p.id === futurePlan),
    '另一年份的计划不因 2026 超额而转待复核');
  // 已开始（3 月）的 plan1/plan2 不转待复核
  assert(!r.body.flaggedPlans.some((p) => p.id === plan1 || p.id === plan2),
    '已开始的计划不转待复核');
  if (pendingPlan) {
    assert(r.body.flaggedPlans.some((p) => p.id === pendingPlan),
      '2026 年未开始计划转为待复核');
  }

  // 与已确认实测重叠的录入被拒绝
  const mr = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '10:00', actualLux: 600,
  }, 'c');
  assert(mr.status === 409, '与已确认实测重叠的录入被拒绝');

  // 超限未解除时，待复核计划复核仍被拒（原审批与测量记录保留）
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 409, '超限状态下复核通过仍被拒绝');
  }

  // 超限状态下，新的计划批准必然 409
  r = await call('POST', '/api/plans', {
    exhibitId, title: '超额后的新计划', startDate: '2026-06-01', endDate: '2026-06-01',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交新计划');
  const blockedPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 409, '超限状态下新计划批准被拒');

  // 已确认实测不可删除
  r = await call('DELETE', `/api/measurements/${meas2}`, null, 'c');
  assert(r.status === 400, '已确认实测不可删除（保留测量记录）');

  // 提额解除 2026 超限：待复核计划复核通过，新计划也可批
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 100000 }, 'c');
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 200, '提额后待复核计划复核通过');
  }
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 200, '提额后新计划可批准');

  // ---- 跨年拆分：未登记年份额度 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '跨年展', startDate: '2027-12-31', endDate: '2028-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '跨年计划可提交');
  const crossPlan = r.body.plan.id;
  r = await call('GET', `/api/plans/${crossPlan}`, null, 'i');
  assert(r.body.estimatedYearly['2027'] === 800 && r.body.estimatedYearly['2028'] === 800,
    '跨年剂量按自然年拆分');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 409, '跨年计划批准被拒');
  // fy 年（约一年后，通常是 2027）可能已登记额度；2028 一定未登记，错误必须指出缺失年份
  assert(/2028/.test(r.body.error), `错误指出 2028 年未登记额度，实际：${r.body.error}`);

  // ---- 并发批准不超配（额度恰好只够一个）----
  // 2027 已被 futurePlan 占用 800（上限 2000），提到 4000 以容纳跨年计划的 800
  if (fy === 2027) {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 4000 }, 'c');
  } else {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 800 }, 'c');
  }
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 900 }, 'c');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 200, `跨年计划批准：2027/2028 各占 800（实际 ${r.status} ${r.body && r.body.error}）`);

  const pairIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发二选一-${i}`, startDate: '2028-03-01', endDate: '2028-03-01',
      periods: ['09:00-10:00'], // 两计划开灯时刻相同 => 互斥
      estimatedLux: 100,
    }, 'i');
    pairIds.push(cr.body.plan.id);
  }
  const rs = await Promise.all(pairIds.map((id) => call('POST', `/api/plans/${id}/approve`, {}, 'c')));
  const oks = rs.filter((x) => x.status === 200).length;
  const rejects = rs.filter((x) => x.status === 409).length;
  assert(oks === 1 && rejects === 1,
    `并发批准相同开灯时段：恰好一个成功（ok=${oks}, reject=${rejects}），不发生超配`);

  // 纯额度并发：2028 剩余 0；提额 +100，两条互不重叠的 100 分钟计划并发批准，只能过一个
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 1000 }, 'c');
  const quotaIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发额度-${i}`, startDate: '2028-04-01', endDate: '2028-04-01',
      periods: [`0${6 + i}:00-0${7 + i}:00`], // 06-07 / 07-08，时间相接不重叠，各 100 lx·h
      estimatedLux: 100,
    }, 'i');
    assert(cr.status === 201, `并发额度计划 ${i} 创建成功（${cr.status} ${cr.body && cr.body.error}）`);
    quotaIds.push(cr.body.plan.id);
  }
  const qr = await Promise.all(quotaIds.map((qid) => call('POST', `/api/plans/${qid}/approve`, {}, 'c')));
  const qok = qr.filter((x) => x.status === 200).length;
  const qrej = qr.filter((x) => x.status === 409).length;
  assert(qok === 1 && qrej === 1,
    `额度仅够一个的并发批准：恰好一个成功（ok=${qok}, reject=${qrej}），不超配`);
  assert(qr.some((x) => x.status === 409 && x.body.details && x.body.details.overflows),
    '被拒响应包含按年超额明细');

  // =======================================================================
  // 计划调整申请（布展员提交 / 撤回，保管员批准 / 驳回）
  // 使用遥远的固定日期（2030/2031），保证“尚未开始”确定成立
  // =======================================================================
  // 第二个布展员，用于越权校验
  r = await call('POST', '/api/users', {
    username: 'installer2', password: 'setup123', role: 'installer', displayName: '布展员乙',
  }, 'c');
  assert(r.status === 201, '创建第二个布展员');
  await call('POST', '/api/auth/login',
    { username: 'installer2', password: 'setup123' }, 'i2');

  const createExhibit = async (name) => {
    const cr = await call('POST', '/api/exhibits', { name }, 'c');
    assert(cr.status === 201, `登记展品 ${name}`);
    return cr.body.exhibit.id;
  };
  const submitPlan = async (exId, title, startDate, endDate, periods, lux) => {
    const cr = await call('POST', '/api/plans',
      { exhibitId: exId, title, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(cr.status === 201, `提交计划 ${title}`);
    return cr.body.plan.id;
  };
  const approvePlan = async (id) => {
    const cr = await call('POST', `/api/plans/${id}/approve`, {}, 'c');
    assert(cr.status === 200, `批准计划 #${id}（${cr.status} ${cr.body && cr.body.error}）`);
  };

  const ex2 = await createExhibit('调整流程展品');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2030, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2031, limitLxh: 10000 }, 'c');

  // 计划 A：2030-06-01 单日 09-17，100lx = 800；计划 B：2030-06-02 夜场 18-22，100lx = 400
  const planA = await submitPlan(ex2, '调整目标A', '2030-06-01', '2030-06-01', ['09:00-17:00'], 100);
  const planB = await submitPlan(ex2, '相邻计划B', '2030-06-02', '2030-06-02', ['18:00-22:00'], 100);
  await approvePlan(planA);
  await approvePlan(planB);
  // 一份尚未批准的计划（submitted），不能提交调整
  const planSubmitted = await submitPlan(ex2, '未批准计划', '2030-07-01', '2030-07-01',
    ['09:00-10:00'], 100);

  // ---- 越权 / 状态 / 输入校验 ----
  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'c');
  assert(r.status === 403, '保管员不能提交调整申请（越权）');

  r = await call('POST', '/api/adjustments', { planId: planSubmitted,
    startDate: '2030-07-01', endDate: '2030-07-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已批准/.test(r.body.error), '未批准计划的调整申请被拒绝');

  // 已开始的已批准计划（plan1 在 2026-03，早已开始）
  r = await call('POST', '/api/adjustments', { planId: plan1,
    startDate: '2031-01-01', endDate: '2031-01-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已开始/.test(r.body.error), '已开始计划的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-09:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '零时长时段的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-10', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '展期倒置的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: -5 }, 'i');
  assert(r.status === 400, '非正照度的调整申请被拒绝');

  // ---- 正常提交 + 重复申请拒绝 + 待审占用 ----
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100, reason: '配合跨年活动改期',
  }, 'i');
  assert(r.status === 201, '提交调整申请 adj1');
  const adj1 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === true, '拟改窗口试算通过（无冲突）');
  assert(r.body.adjustment.preview.newResidueYearly['2030'] === 800 &&
    r.body.adjustment.preview.newResidueYearly['2031'] === 800,
    '拟改残余按年各 800');

  // 重复提交被拒
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-02-01', endDate: '2031-02-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409 && r.body.details.existingAdjustmentId === adj1,
    '同一计划重复待审申请被拒绝（409，指明既有申请）');

  // 待审期间原计划继续占用额度：展品 2030 已用仍为 A(800)+B(400)=1200
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'i');
  assert(r.body.years['2030'].used === 1200, '待审期间原计划继续占用额度（2030=1200）');
  // 计划行带有待审申请与原值/拟改值
  const planARow = r.body.plans.find((p) => p.id === planA);
  assert(planARow.pendingAdjustment && planARow.pendingAdjustment.id === adj1,
    '展品详情计划行展示待审调整申请');

  // 另一布展员不能撤回
  r = await call('POST', `/api/adjustments/${adj1}/withdraw`, {}, 'i2');
  assert(r.status === 403, '非申请人撤回被拒绝（403）');
  // 保管员也不能批准尚未……（先测试驳回不改计划，随后撤回重提）
  r = await call('POST', `/api/adjustments/${adj1}/reject`, { reason: '改期材料不全' }, 'c');
  assert(r.status === 200, '保管员驳回 adj1');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-06-01' && !r.body.plan.pendingAdjustment,
    '驳回不改变计划原值，且不再有待审申请');

  // ---- 撤回后可重提 ----
  // 先提交再撤回
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '驳回后可重新提交 adj2');
  const adj2 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj2}/withdraw`, {}, 'i');
  assert(r.status === 200, '申请人撤回 adj2');
  r = await call('POST', `/api/adjustments/${adj2}/approve`, {}, 'c');
  assert(r.status === 400, '已撤回申请不能再批准');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '撤回后可再次提交 adj3');
  const adj3 = r.body.adjustment.id;

  // ---- 批准冲突：与其他已批准计划开灯重叠（申请保持待审）----
  // 把拟改窗口改成与计划 B（2030-06-02 18-22）重叠
  await call('POST', `/api/adjustments/${adj3}/withdraw`, {}, 'i');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-06-02', endDate: '2030-06-02',
    periods: ['20:00-21:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交与 B 重叠的 adj4（提交时不拦截，批准时核对）');
  const adj4 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false, '试算标记不通过');
  assert(r.body.adjustment.preview.conflicts.overlappingPlans.some((p) => p.id === planB),
    '试算指出冲突计划 B');
  r = await call('POST', `/api/adjustments/${adj4}/approve`, {}, 'c');
  assert(r.status === 409, '重叠调整申请批准被拒（409）');
  assert(/相邻计划B/.test(r.body.error), '错误信息指出冲突计划');
  assert(r.body.details.conflicts.overlappingPlans[0].id === planB,
    '结构化冲突明细包含冲突计划');
  // 申请保持待审，可撤回
  r = await call('GET', `/api/adjustments/${adj4}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '核对失败后申请保持待审');
  await call('POST', `/api/adjustments/${adj4}/withdraw`, {}, 'i');

  // ---- 批准冲突：未作废实测落在新开灯窗外（draft 也算未作废）----
  // 先批准合规调整，随后在新窗口内录入实测；再用一个排除该实测的新窗口申请
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  const adj5 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj5}/approve`, {}, 'c');
  assert(r.status === 200, '批准合规调整 adj5，原子更新计划');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-12-31' && ymd(r.body.plan.end_date) === '2031-01-01' &&
    r.body.plan.estimated_lux === 100, '计划展期已更新为拟改值');
  assert(!r.body.plan.pendingAdjustment, '通过后无待审申请');

  // 在新窗口内录入一条实测（draft，未作废）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '12:00', actualLux: 120,
  }, 'c');
  assert(r.status === 201, '在更新后窗口内录入实测草稿');
  const adjMeasId = r.body.measurement.id;
  // 再次调整到不含该实测的窗口（2031-06-01 09-12）
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-06-01', endDate: '2031-06-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交排除既有实测窗口的 adj6');
  const adj6 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj6}/approve`, {}, 'c');
  assert(r.status === 409, '含窗外未作废实测的调整批准被拒');
  assert(new RegExp(`实测 #${adjMeasId}`).test(r.body.error), '错误信息指出冲突实测');
  assert(r.body.details.conflicts.outsideMeasurements[0].id === adjMeasId,
    '结构化冲突明细包含冲突实测');
  await call('POST', `/api/adjustments/${adj6}/withdraw`, {}, 'i');

  // ---- 批准冲突：按年超额 ----
  const ex3 = await createExhibit('调整超额展品');
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 800 }, 'c');
  const planC = await submitPlan(ex3, '小额计划C', '2030-08-01', '2030-08-01',
    ['09:00-17:00'], 50); // 400
  await approvePlan(planC);
  // 申请把照度改为 200lx（仍 8h）=> 1600，超 2030 上限 800，超额 800
  r = await call('POST', '/api/adjustments', {
    planId: planC, startDate: '2030-08-01', endDate: '2030-08-01',
    periods: ['09:00-17:00'], estimatedLux: 200,
  }, 'i');
  assert(r.status === 201, '提交超额调整 adj7');
  const adj7 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false &&
    r.body.adjustment.preview.conflicts.overflows[0].year === 2030,
    '试算指出超额年份 2030');
  r = await call('POST', `/api/adjustments/${adj7}/approve`, {}, 'c');
  assert(r.status === 409, '超额调整批准被拒（409）');
  const o = r.body.details.conflicts.overflows.find((x) => x.year === 2030);
  assert(o && o.limit === 800 && o.newResidue === 1600 && o.projected === 1600 &&
    o.excess === 800, `超额明细数值正确：${JSON.stringify(o)}`);
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 50, '核对失败不改变计划（照度仍 50）');
  assert(r.body.plan.pendingAdjustment && r.body.plan.pendingAdjustment.id === adj7,
    '超额申请保持待审');
  // 提额后重新核对通过（同一份申请无需撤回重提）
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 2000 }, 'c');
  r = await call('POST', `/api/adjustments/${adj7}/approve`, {}, 'c');
  assert(r.status === 200, '提额后同一待审申请批准通过');
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 200, '计划照度更新为拟改值 200');

  // ---- 实测覆盖部分新窗口：以新窗口未被实测覆盖部分估算 ----
  // 删除上面的 draft 实测（草稿可删），改用已确认实测落在 A 当前窗口（2030-12-31~2031-01-01）
  await call('DELETE', `/api/measurements/${adjMeasId}`, null, 'c');
  // 2030-12-31 09:00-17:00 整段实测 100lx（确认，覆盖 2030 那天 8h）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '17:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入覆盖 2030 当天的实测草稿');
  const measFull = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${measFull}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（2030 占用改为实测 800）');
  // 拟改窗口不变（同窗口），批准一个“仅照度变化”的调整：新残余 2030=0（被覆盖），2031=800
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 300,
  }, 'i');
  assert(r.status === 201, '提交照度调整 adj8');
  const adj8 = r.body.adjustment.id;
  const pv = r.body.adjustment.preview;
  assert((pv.newResidueYearly['2030'] || 0) === 0 && pv.newResidueYearly['2031'] === 2400,
    `新窗口已确认实测覆盖部分不估算：2030=0,2031=2400，实际 ${JSON.stringify(pv.newResidueYearly)}`);
  r = await call('POST', `/api/adjustments/${adj8}/approve`, {}, 'c');
  assert(r.status === 200, '含已确认实测覆盖的调整批准通过');
  // 2030 占用：实测 800 + B(400) = 1200（原 A 残余被实测替代，调整后仍为 0 残余）
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'c');
  assert(r.body.years['2030'].used === 1200,
    `调整后 2030 占用=实测800+B400=1200，实际 ${r.body.years['2030'].used}`);
  assert(r.body.years['2031'].used === 2400, `2031 占用=新残余 2400，实际 ${r.body.years['2031'].used}`);

  // ---- 调整申请列表接口 ----
  r = await call('GET', '/api/adjustments?exhibitId=' + ex2 + '&status=approved', null, 'i');
  assert(r.status === 200 && r.body.adjustments.some((a) => a.id === adj5),
    '可按展品/状态查询已通过调整申请');
  r = await call('GET', '/api/adjustments?planId=' + planC, null, 'i');
  assert(r.body.adjustments.every((a) => a.planId === planC) &&
    r.body.adjustments.some((a) => a.status === 'approved'),
    '按计划查询调整历史');

  // =======================================================================
  // 下调年度上限：预演 → 携凭证提交；旧接口直接修改；占用变化拒绝
  // =======================================================================
  const exL = await createExhibit('下调额度展品');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');

  // 已开始的已批准计划（2026 墙上时间 3 月，当前 2026-10，必已开始）：8h*100=800
  const pStarted = await submitPlan(exL, '已开始计划', '2026-03-01', '2026-03-01',
    ['09:00-17:00'], 100);
  await approvePlan(pStarted);
  // 2032 年尚未开始的计划两条，各 800
  const pFut1 = await submitPlan(exL, '未来计划1', '2032-06-01', '2032-06-01',
    ['09:00-17:00'], 100);
  const pFut2 = await submitPlan(exL, '未来计划2', '2032-07-01', '2032-07-01',
    ['09:00-17:00'], 100);
  await approvePlan(pFut1);
  await approvePlan(pFut2);

  // ---- 预演：越权 / 输入 / 非下调 / 未登记年份 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'i');
  assert(r.status === 403, '布展员不能预演下调（越权）');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: -5 }, 'c');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正上限预演报错');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 12000 }, 'c');
  assert(r.status === 400 && /不属于下调/.test(r.body.error), '拟定上限不低于现行上限被拒');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2099, limitLxh: 100 }, 'c');
  assert(r.status === 400 && /尚未登记/.test(r.body.error), '未登记上限的年份不能下调预演');

  // ---- 预演不改状态：2032 降到 800，used=1600，超额 800 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 200, '预演成功');
  let lpv = r.body.preview;
  assert(lpv.currentLimit === 10000 && lpv.proposedLimit === 800 && lpv.used === 1600 &&
    lpv.excess === 800 && lpv.over === true,
    `预演数值正确：${JSON.stringify({ c: lpv.currentLimit, u: lpv.used, e: lpv.excess })}`);
  assert(lpv.confirmedMeasurements.length === 0, '该年无已确认实测');
  assert(lpv.planResidues.length === 2 &&
    lpv.planResidues.every((p) => p.yearResidue === 800 && p.notStarted),
    '列出两条未开始计划各 800 残余');
  assert(lpv.flagCandidates.length === 2 &&
    lpv.flagCandidates.map((p) => p.id).sort().join(',') === [pFut1, pFut2].sort().join(','),
    '两条未开始计划都在转待复核候选中');
  assert(typeof lpv.token === 'string' && lpv.token.length >= 32, '返回预演凭证');
  // 预演后状态不变
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 10000, '预演不修改上限');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'approved',
    '预演不修改计划状态');

  // ---- 无凭证 / 错字段提交被拒（字段类 400 不消耗凭证，可改正后重试）----
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 400 && /预演/.test(r.body.error), '缺少凭证拒绝提交');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 900, token: lpv.token }, 'c');
  assert(r.status === 400 && /不一致/.test(r.body.error), '凭证与拟定上限不一致被拒');
  // 字段不符不消耗凭证：原凭证按正确字段仍可通过状态校验（这里直接用于成功提交验证一次性语义）
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '字段类错误不消耗凭证，原凭证仍可成功提交');
  // 成功提交后凭证已被消耗，重放被拒
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 400 && /已使用或不存在/.test(r.body.error), '凭证一次性：成功后重放被拒');

  // 提交后两计划已转待复核，先恢复现场以便后续场景：提额并复核回 approved
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c');

  // ---- 再次预演 + 提交下调：覆盖上面未走的成功路径断言 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  lpv = r.body.preview;
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '携凭证下调成功');
  assert(r.body.years['2032'].limit === 800 && r.body.years['2032'].used === 1600 &&
    r.body.years['2032'].over === true, '下调后上限 800、已用 1600、显示超限');
  assert(r.body.overflows[0].excess === 800 && r.body.overflows[0].previousLimit === 10000,
    '成功响应附带超额与旧上限');
  const st1 = r.body.plans.find((p) => p.id === pFut1);
  const st2 = r.body.plans.find((p) => p.id === pFut2);
  assert(st1.status === 'pending_review' && st2.status === 'pending_review',
    '两条未开始计划转为待复核');
  assert(/上限下调/.test(st1.review_reason || '') && /超额/.test(st1.review_reason || ''),
    '待复核原因写明上限下调与超额：' + st1.review_reason);
  // 原审批保留：approved_by/approved_at 仍在（详情接口带 approver_name）
  assert(st1.approved_by != null, '原审批人保留');

  // ---- 超额未解除时复核沿用现有额度校验，仍被拒；不删除占用/不自动取消 ----
  r = await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  assert(r.status === 409, '超额状态下待复核计划复核通过被拒');
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'pending_review' &&
    r.body.years['2032'].used === 1600,
    '复核被拒不删除占用、计划仍待复核');

  // ---- 占用已变化则携旧凭证拒绝并返回最新结果（含新凭证）----
  // 先提额回 10000，复核通过 pFut1（占用/状态变化），再预演降到 800，
  // 随后又批准 pFut2 复核，使占用变化（本例占用数值不变但状态/指纹变化）；
  // 更直接的变化：预演后登记一条已确认实测会改变占用。先准备一条新计划以便录实测。
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 100000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c'); // pFut1 -> approved
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c'); // pFut2 -> approved

  // 新的已批准未开始计划（2032-09-01 09-17，100lx = 800），用于录入实测改变占用
  const pMeas = await submitPlan(exL, '实测承载计划', '2032-09-01', '2032-09-01',
    ['09:00-17:00'], 100);
  await approvePlan(pMeas);

  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 2000 }, 'c');
  assert(r.status === 200, '再次预演（used=2400，超额 400）');
  const staleToken = r.body.preview.token;
  assert(r.body.preview.used === 2400 && r.body.preview.excess === 400,
    `预演 used=2400/excess=400，实际 ${r.body.preview.used}/${r.body.preview.excess}`);

  // 预演后插入一条已确认实测：2032-09-01 09-17 实测 200lx = 1600，替代该计划 800 估算
  r = await call('POST', '/api/measurements', {
    planId: pMeas, startDate: '2032-09-01', startTime: '09:00',
    endDate: '2032-09-01', endTime: '17:00', actualLux: 200,
  }, 'c');
  assert(r.status === 201, '预演后录入实测草稿');
  const mNew = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${mNew}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（占用变化，且 100000 上限下不触发转复核）');

  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: staleToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '占用变化后旧凭证提交被拒（409）');
  const freshPv = r.body.details.preview;
  assert(freshPv && freshPv.token && freshPv.token !== staleToken,
    '拒绝时返回最新预演结果与新凭证');
  assert(freshPv.used === 3200 && freshPv.excess === 1200,
    `最新结果 used=3200（1600 实测 + 两条 800），实际 ${freshPv.used}`);
  assert(freshPv.confirmedMeasurements.some((m) => m.id === mNew && m.yearDose === 1600),
    '最新结果列出新增已确认实测');
  // 上限未被修改
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 100000, '拒绝后上限保持不变');

  // 用返回的新凭证可直接提交
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: freshPv.token }, 'c');
  assert(r.status === 200, '最新结果携带的新凭证可成功提交');
  assert(r.body.years['2032'].limit === 2000, '新上限 2000 生效');
  // 已确认实测与审批保留
  assert(r.body.measurements.some((m) => m.id === mNew && m.status === 'confirmed'),
    '已确认实测保留');

  // ---- 预演后“额度本身”被他人改动（占用未变），同样拒绝 ----
  const exQ = await createExhibit('额度被改展品');
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 5000 }, 'c');
  const pQ = await submitPlan(exQ, 'Q计划', '2033-01-01', '2033-01-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(pQ);
  r = await call('POST', `/api/exhibits/${exQ}/limits/preview`,
    { year: 2033, limitLxh: 500 }, 'c');
  const qToken = r.body.preview.token;
  assert(r.body.preview.used === 800 && r.body.preview.excess === 300, '预演超额 300');
  // 他人经旧接口把上限改为 4000（占用未变，额度变了）
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 4000 }, 'c');
  r = await call('POST', `/api/exhibits/${exQ}/limits/lower`,
    { year: 2033, limitLxh: 500, token: qToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '额度被改后旧凭证被拒');
  assert(r.body.details.preview.currentLimit === 4000,
    '新结果反映最新现行上限 4000');

  // ---- 已开始计划不转状态，剩余超额如实显示 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 100 }, 'c');
  assert(r.status === 200, '2026 下调预演');
  lpv = r.body.preview;
  assert(lpv.used === 800 && lpv.excess === 700, '2026 已用 800，超额 700');
  assert(lpv.flagCandidates.length === 0, '已开始计划不在转待复核候选中');
  assert(lpv.startedResiduePlans.length === 1 && lpv.startedResiduePlans[0].id === pStarted,
    '已开始但仍占残余的计划单独列出');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 100, token: lpv.token }, 'c');
  assert(r.status === 200, '2026 下调成功');
  assert(r.body.overflows[0].excess === 700, '剩余超额如实返回');
  assert(!r.body.flaggedPlans.some((p) => p.id === pStarted), '已开始计划不转状态');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '已开始计划仍为已批准');
  assert(r.body.years['2026'].over === true && r.body.years['2026'].used === 800,
    '页面数据如实显示 2026 超限 700');

  // ---- 不超额的下调：直接成功，不产生转待复核 ----
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 5000 }, 'c'); // 先提额
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 1000 }, 'c');
  assert(r.body.preview.over === false && r.body.preview.remaining === 200,
    '下调到 1000（used=800）不超额，剩余 200');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 1000, token: r.body.preview.token }, 'c');
  assert(r.status === 200 && r.body.overflows.length === 0, '不超额下调成功且无超额明细');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '不超额时计划状态不变');

  // ---- 旧接口沿用旧字段直接修改：同事务即时重算，成功响应兼容（仍为展品详情）----
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 500 }, 'c');
  assert(r.status === 200 && r.body.exhibit && r.body.years && r.body.plans,
    '旧接口成功响应仍是展品详情（兼容）');
  assert(r.body.years['2026'].limit === 500 && r.body.overflows[0].excess === 300,
    '旧接口同事务重算：上限 500，超额 300');
  assert(r.body.flaggedPlans.length === 0, '旧接口下调时已开始计划同样不转状态');
  // 旧接口上调/登记不产生下调核算字段
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 9000 }, 'c');
  assert(r.status === 200 && r.body.limitLowered === null &&
    r.body.overflows.length === 0 && r.body.flaggedPlans.length === 0,
    '旧接口上调不附带下调结果');
  r = await call('GET', `/api/exhibits`, null, 'i');
  assert(r.body.exhibits.some((e) => e.id === exL && e.years['2026']),
    '额度列表查询响应保持兼容');

  // ---- 操作流水存在 ----
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.status === 200 && r.body.events.some((e) => e.action === 'plan.approve'),
    '操作流水记录了审批事件');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.submit'),
    '操作流水记录了调整申请提交');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.approve'),
    '操作流水记录了调整申请批准');
  assert(r.body.events.some((e) => e.action === 'plan.update_via_adjustment'),
    '操作流水记录了计划经调整更新');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.withdraw'),
    '操作流水记录了调整申请撤回');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.reject'),
    '操作流水记录了调整申请驳回');
  assert(r.body.events.some((e) => e.action === 'limit.lower'),
    '操作流水记录了携凭证下调上限');
  assert(r.body.events.some((e) => e.action === 'plan.flag_review_limit_lower'),
    '操作流水记录了下调上限导致的转待复核');
  assert(r.body.events.some((e) => e.action === 'limit.upsert'),
    '操作流水记录了登记/修改上限');
}

main().catch((err) => {
  console.error('集成测试失败:', err);
  process.exit(1);
});
