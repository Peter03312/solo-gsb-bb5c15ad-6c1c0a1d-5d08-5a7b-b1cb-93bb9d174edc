'use strict';

const {
  ValidationError,
  ConflictError,
  parsePeriods,
  assertDate,
  positiveNumber,
  nonEmptyString,
} = require('./validation');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  addYearDose,
  intersects,
  containsInterval,
  anyIntersect,
  round3,
  wallToTs,
  tsToWallString,
  yearOfTs,
} = require('./dosing');

const ACTIVE_PLAN_STATUSES = ['approved', 'pending_review'];
const PENDING_ADJUSTMENT = 'pending';

/** 规范化 DATE 值：真实 pg 经类型解析返回 'YYYY-MM-DD'；个别驱动（如内存测试）可能给 Date。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

/** 读取展品（可加行锁，事务内批准/确认时使用）。 */
async function lockExhibit(client, exhibitId) {
  const { rows } = await client.query('SELECT * FROM exhibits WHERE id = $1 FOR UPDATE', [exhibitId]);
  if (rows.length === 0) throw new ValidationError('展品不存在');
  return rows[0];
}

async function getPlan(client, planId) {
  const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (rows.length === 0) throw new ValidationError('计划不存在');
  return rows[0];
}

/**
 * 取该展品占用额度的计划（已批准、待复核）。
 * excludePlanIds 用于把成对核对中的两条计划一并排除：可传单 id、id 数组或 null。
 */
async function getOccupyingPlans(client, exhibitId, excludePlanIds = null) {
  const ids = excludePlanIds === null || excludePlanIds === undefined
    ? []
    : (Array.isArray(excludePlanIds) ? excludePlanIds : [excludePlanIds])
        .filter((id) => id !== null && id !== undefined);
  // 状态为模块内固定白名单，直接内联到 SQL（避免不同驱动对 ANY($) 数组绑定的差异）
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const placeholders = ['$1', ...ids.map((_, i) => `$${i + 2}`)];
  const notIn = ids.length === 0 ? '' : `AND id NOT IN (${placeholders.slice(1).join(',')})`;
  const { rows } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = ${placeholders[0]} AND status IN (${statusList})
        ${notIn}
      ORDER BY id`,
    [exhibitId, ...ids]
  );
  return rows;
}

async function getActiveMeasurements(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT m.*, p.status AS plan_status
       FROM measurements m JOIN plans p ON p.id = m.plan_id
      WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
      ORDER BY m.start_ts`,
    [exhibitId]
  );
  return rows;
}

function planWindows(plan) {
  return buildWindows(dateYmd(plan.start_date), dateYmd(plan.end_date), parsePeriods(normalizePeriods(plan.light_periods)));
}

/** JSONB 开灯时段：真实 pg 驱动返回数组，个别驱动（如内存测试）返回字符串，统一成数组。 */
function normalizePeriods(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      throw new ValidationError('开灯时段数据格式无效');
    }
  }
  return value;
}

/**
 * 计划在扣除已确认实测覆盖后的估算剂量（按年）。
 * measWindows: computeOccupancy 中构造的实测区间数组。
 */
function planResidueYearly(plan, measWindows) {
  const windows = planWindows(plan);
  const coverers = measWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
  const remaining = subtractIntervals(windows, coverers);
  return yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
}

/** 区间重叠的已确认实测（同一展品，排除作废），含端点比较。 */
async function findOverlappingMeasurement(client, exhibitId, startMs, endMs, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/**
 * 计算一件展品的年度额度占用。
 * 口径：
 *   used[year] = Σ 已确认实测剂量（按时窗自然年拆分）
 *              + Σ 已批准/待复核计划“未被已确认实测覆盖部分”的估算剂量
 * 同一计划窗口先被该展品全部已确认实测（通常即本计划的实测）扣除，再按其照度估算，
 * 因此实测确认后该时段自动以实测替代估算。
 */
async function computeOccupancy(client, exhibitId, { excludePlanId = null, excludePlanIds = null, extraMeasurement = null } = {}) {
  const excludes = excludePlanIds !== null
    ? (Array.isArray(excludePlanIds) ? excludePlanIds : [excludePlanIds])
    : (excludePlanId !== null ? [excludePlanId] : []);
  const plans = await getOccupyingPlans(client, exhibitId, excludes);
  const measurements = await getActiveMeasurements(client, exhibitId);
  const limitRows = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1',
    [exhibitId]
  );
  const limits = {};
  for (const r of limitRows.rows) limits[String(r.year)] = Number(r.limit_lxh);

  const measWindows = measurements.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
  }));
  // 预演一条尚未确认（或刚录入）的实测，用于超额预判
  if (extraMeasurement) {
    measWindows.push({
      id: extraMeasurement.id || -1,
      planId: extraMeasurement.planId,
      start: extraMeasurement.start,
      end: extraMeasurement.end,
      lux: extraMeasurement.lux,
      draft: true,
    });
  }

  const used = {};
  const sources = [];

  // 1) 实测部分
  for (const mw of measWindows) {
    const yearly = yearMapToObject(doseByYear([{ start: mw.start, end: mw.end }], mw.lux));
    addYearDose(used, yearly);
    sources.push({
      kind: 'measurement',
      id: mw.id,
      planId: mw.planId,
      start: tsToWallString(mw.start),
      end: tsToWallString(mw.end),
      lux: mw.lux,
      yearly,
    });
  }

  // 2) 计划的估算残余
  for (const plan of plans) {
    const yearly = planResidueYearly(plan, measWindows);
    addYearDose(used, yearly);
    sources.push({
      kind: 'plan',
      id: plan.id,
      title: plan.title,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      periods: plan.light_periods,
      lux: Number(plan.estimated_lux),
      yearly,
    });
  }

  const years = {};
  const allYears = new Set([
    ...Object.keys(limits),
    ...Object.keys(used),
  ].map(Number));
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = limits[key] !== undefined ? round3(limits[key]) : null;
    years[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  return { limits, used, years, sources, plans, measurements };
}

/** 检查新增/复核的年度剂量并入当前占用后是否超限，返回超额明细数组。 */
function buildOverflows(currentUsed, limits, addedYearly) {
  const overflows = [];
  for (const [yearStr, add] of Object.entries(addedYearly)) {
    const limit = limits[yearStr];
    if (limit === undefined || limit === null) {
      throw new ConflictError(`${yearStr} 年尚未登记年度额度，无法批准`, {
        missingLimit: yearStr,
      });
    }
    const projected = round3((currentUsed[yearStr] || 0) + add);
    if (projected - limit > 0.005) {
      overflows.push({
        year: Number(yearStr),
        limit: round3(limit),
        usedBefore: round3(currentUsed[yearStr] || 0),
        addedByThisPlan: round3(add),
        projected,
        excess: round3(projected - limit),
      });
    }
  }
  return overflows;
}

/** 计划时间窗是否与同展品另一占用计划相交。 */
function planOverlaps(targetWindows, otherPlan) {
  return anyIntersect(targetWindows, planWindows(otherPlan));
}

/**
 * 校验实测时段：
 *  - 必须落在所属已批准/待复核计划的开灯窗内
 *  - 不得与同展品任何未作废实测重叠
 * 返回 { start, end, windows }（毫秒）
 */
async function validateMeasurementWindow(client, plan, startYmd, startMinute, endYmd, endMinute, excludeMeasId = null) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError('只有已批准（或待复核）计划才能登记实测');
  }
  const start = wallToTs(startYmd, startMinute);
  const end = wallToTs(endYmd, endMinute);
  if (!(end > start)) throw new ValidationError('实测时段结束必须晚于开始');

  const windows = planWindows(plan);
  const seg = { start, end };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `实测时段 ${tsToWallString(start)} ~ ${tsToWallString(end)} 不在该计划的开灯时段内`
    );
  }
  const overlap = await findOverlappingMeasurement(client, plan.exhibit_id, start, end, excludeMeasId);
  if (overlap) {
    throw new ConflictError(
      `与已登记实测 #${overlap.id}（${tsToWallString(new Date(overlap.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(overlap.end_ts).getTime())}）时间重叠，已拒绝`,
      { overlappingMeasurementId: overlap.id }
    );
  }
  return { start, end, windows };
}

/**
 * 迟到实测超额后，找出需要转为“待复核”的计划：
 * 同展品、已批准、在超额年份尚有估算剂量、且计划首个开灯时刻尚未开始。
 */
function plansToFlag(plans, occupancy, overflowYears, nowMs) {
  const planEstimate = new Map();
  for (const src of occupancy.sources.filter((s) => s.kind === 'plan')) {
    planEstimate.set(src.id, src.yearly);
  }
  const flagged = [];
  for (const plan of plans) {
    if (plan.status !== 'approved') continue;
    const yearly = planEstimate.get(plan.id) || {};
    if (!overflowYears.some((y) => (yearly[String(y)] || 0) > 0)) continue;
    const firstStart = Math.min(...planWindows(plan).map((w) => w.start));
    if (firstStart > nowMs) flagged.push({ plan, firstStart });
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// 计划调整申请
// ---------------------------------------------------------------------------

/**
 * 规范化“新展期 + 每日开灯时段 + 预计照度”输入（创建计划与调整申请共用）。
 * 返回 { startDate, endDate, periodSpecs, periods, estimatedLux }。
 */
function normalizeScheduleInput(body, { withTitle = false } = {}) {
  const out = {};
  if (withTitle) out.title = nonEmptyString(body.title, '计划名称', 200);
  const startDate = assertDate(body.startDate, '开始日期');
  const endDate = assertDate(body.endDate, '结束日期');
  if (endDate < startDate) throw new ValidationError('结束日期不能早于开始日期');
  const rawPeriods = body.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.some((p) => typeof p !== 'string')) {
    throw new ValidationError('每日开灯时段必须是字符串数组，如 ["09:00-12:00"]');
  }
  const periods = parsePeriods(rawPeriods);
  // 规范为 HH:MM-HH:MM（允许输入 HH:MM:00）
  const periodSpecs = periods.map((p) => {
    const endMin = (p.startMin + p.durationMin) % 1440;
    const fmt = (min) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    return `${fmt(p.startMin)}-${fmt(endMin)}`;
  });
  const estimatedLux = positiveNumber(body.estimatedLux, '预计照度（lx）', { max: 1000000 });

  // 展期最长约 5 年，防止误填导致的巨型计算
  const spanMs =
    Date.UTC(
      Number(endDate.slice(0, 4)),
      Number(endDate.slice(5, 7)) - 1,
      Number(endDate.slice(8, 10))
    ) -
    Date.UTC(
      Number(startDate.slice(0, 4)),
      Number(startDate.slice(5, 7)) - 1,
      Number(startDate.slice(8, 10))
    );
  if (spanMs / 86400000 + 1 > 1860) throw new ValidationError('展期跨度不能超过约 5 年');

  return { ...out, startDate, endDate, periodSpecs, periods, estimatedLux };
}

/** 取某计划当前唯一一份待审调整申请（无则 null）。 */
async function getPendingAdjustment(client, planId) {
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.plan_id = $1 AND a.status = 'pending'
      ORDER BY a.id DESC
      LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

/** 取多份计划各自的待审调整申请，返回 Map<planId, adjustment>。 */
async function getPendingAdjustments(client, planIds) {
  const result = new Map();
  const ids = [...new Set(planIds.filter((id) => id !== null && id !== undefined))];
  if (ids.length === 0) return result;
  // 动态占位符，避免不同驱动对 ANY($) 数组绑定的差异
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.status = 'pending' AND a.plan_id IN (${placeholders})
      ORDER BY a.id DESC`,
    ids
  );
  for (const row of rows) {
    if (!result.has(Number(row.plan_id))) result.set(Number(row.plan_id), row);
  }
  return result;
}

/**
 * 计划首个开灯时刻（毫秒）。
 */
function planFirstStart(plan) {
  return Math.min(...planWindows(plan).map((w) => w.start));
}

/** 计划是否“尚未开始”（首个开灯时刻晚于 now）。 */
function planNotStarted(plan, nowMs = Date.now()) {
  return planFirstStart(plan) > nowMs;
}

/** 调整申请的拟改开灯窗（毫秒区间）。 */
function adjustmentWindows(adj) {
  return buildWindows(
    dateYmd(adj.start_date),
    dateYmd(adj.end_date),
    parsePeriods(normalizePeriods(adj.light_periods))
  );
}

/** 取某计划全部未作废（draft/confirmed）实测。 */
async function getNonAnnulledMeasurements(client, planId) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts, status, actual_lux
       FROM measurements
      WHERE plan_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [planId]
  );
  return rows;
}

/** 实测行 -> 毫秒区间数组（可只取已确认）。 */
function measurementIntervals(measRows, { confirmedOnly = false } = {}) {
  return measRows
    .filter((m) => !confirmedOnly || m.status === 'confirmed')
    .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }));
}

/**
 * 窗口在扣除与其相交的已确认实测区间后的估算残余（按自然年）。
 * 与 computeOccupancy 口径一致：只扣除落在窗口内（相交）的实测覆盖部分。
 */
function residueYearlyFromWindows(windows, confirmedIntervals, lux) {
  const coverers = confirmedIntervals.filter((mw) => windows.some((w) => intersects(w, mw)));
  const remaining = subtractIntervals(windows, coverers);
  return yearMapToObject(doseByYear(remaining, Number(lux)));
}

/** 列出未被目标开窗完整包含的未作废实测（含 draft）。 */
function outsideMeasurementsReport(measRows, targetWindows) {
  const outside = [];
  for (const m of measRows) {
    const seg = {
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    };
    if (!targetWindows.some((w) => containsInterval(w, seg))) {
      outside.push({
        id: m.id,
        status: m.status,
        lux: Number(m.actual_lux),
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
      });
    }
  }
  return outside;
}

/** 计划原值摘要（错误信息与审计共用）。 */
function planOriginalValues(plan) {
  return {
    startDate: String(plan.start_date).slice(0, 10),
    endDate: String(plan.end_date).slice(0, 10),
    periods: normalizePeriods(plan.light_periods),
    estimatedLux: Number(plan.estimated_lux),
  };
}

/** 调整申请拟改值摘要。 */
function adjustmentProposedValues(adj) {
  return {
    startDate: dateYmd(adj.start_date),
    endDate: dateYmd(adj.end_date),
    periods: normalizePeriods(adj.light_periods),
    estimatedLux: Number(adj.estimated_lux),
  };
}

/**
 * 调整申请试算（事务内、已持有展品行锁后调用）：
 * 保管员批准时重新核对的全部规则：
 *   1) 计划仍已批准且尚未开始
 *   2) 同展品所有未作废（draft/confirmed）实测都落在新开灯窗内（本计划的实测；
 *      其他计划的窗口与本计划窗口不相交，其实测必然落在新窗外，不属于本计划核对范围）
 *   3) 新窗口不与同展品其他已批准/待复核计划的开灯时刻重叠
 *   4) 按自然年：原计划“估算残余”替换为新窗口“未被已确认实测覆盖部分”的估算剂量后，
 *      任一年不得超过年度上限（未登记上限的年份也算冲突）
 * 返回 { ok, plan, windows, conflicts:{notApproved,notStarted,outsideMeasurements,
 *          overlappingPlans, overflows, missingLimits}, oldResidueYearly, newResidueYearly,
 *          occupiedWithoutPlan, yearlyReport }
 */
async function evaluateAdjustment(client, plan, adjInput, nowMs = Date.now()) {
  const targetWindows = adjustmentWindows(adjInput);
  const conflicts = {
    notApproved: plan.status !== 'approved',
    notStarted: !planNotStarted(plan, nowMs),
    outsideMeasurements: [],
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  // 1) 未作废实测必须完整落在某个新开灯窗内（仅核对本计划的实测）
  const measRows = await getNonAnnulledMeasurements(client, plan.id);
  conflicts.outsideMeasurements = outsideMeasurementsReport(measRows, targetWindows);

  // 2) 与同展品其他已批准/待复核计划的开灯时刻重叠
  const others = await getOccupyingPlans(client, plan.exhibit_id, plan.id);
  for (const other of others) {
    if (planOverlaps(targetWindows, other)) {
      conflicts.overlappingPlans.push({
        id: other.id,
        title: other.title,
        status: other.status,
        startDate: dateYmd(other.start_date),
        endDate: dateYmd(other.end_date),
      });
    }
  }

  // 3) 按自然年替换估算残余后的额度核算
  // 本计划已确认实测覆盖的区间（draft 不计量、仍由估算占位）
  const newResidueYearly = residueYearlyFromWindows(
    targetWindows,
    measurementIntervals(measRows, { confirmedOnly: true }),
    Number(adjInput.estimated_lux)
  );

  const occupancy = await computeOccupancy(client, plan.exhibit_id, { excludePlanId: plan.id });
  const limits = occupancy.limits;
  const occupiedWithoutPlan = occupancy.used;

  // 原残余按年（与 computeOccupancy 对本计划的口径一致：扣除该展品全部与其相交的已确认实测）
  const oldWindows = planWindows(plan);
  const allConfirmed = await getActiveMeasurements(client, plan.exhibit_id);
  const oldResidue = residueYearlyFromWindows(
    oldWindows,
    allConfirmed.map((m) => ({
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    })),
    Number(plan.estimated_lux)
  );

  // 4) 合并每个相关年份：上限、不含本计划的占用、原残余、新残余、合计、超额
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupiedWithoutPlan),
    ...Object.keys(oldResidue),
    ...Object.keys(newResidueYearly),
  ].map(Number));
  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const otherUsed = round3(occupiedWithoutPlan[key] || 0);
    const oldVal = round3(oldResidue[key] || 0);
    const newVal = round3(newResidueYearly[key] || 0);
    const projected = round3(otherUsed + newVal);
    const row = {
      year,
      limit,
      usedByOthers: otherUsed,
      oldResidue: oldVal,
      newResidue: newVal,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 新残余占用了该年却没登记上限 -> 冲突
      if (newVal > 0) conflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      conflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    !conflicts.notApproved &&
    !conflicts.notStarted &&
    conflicts.outsideMeasurements.length === 0 &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.overflows.length === 0 &&
    conflicts.missingLimits.length === 0;

  return {
    ok,
    conflicts,
    windows: targetWindows,
    oldResidueYearly: oldResidue,
    newResidueYearly,
    occupiedWithoutPlan,
    yearlyReport,
  };
}

/**
 * 成对调整核对（事务内、已持有展品行锁后调用）：
 * 保管员把同一展品两份待审调整申请成对核准（用于两条已批准且未开始计划互换/协同挪动档期）。
 *
 * 调用方须保证：两份申请存在、分属不同计划、同属展品 exhibitId（结构性校验在路由层）。
 * 本函数在锁内重新核对全部业务规则：
 *   1) 两条计划仍已批准且尚未开始
 *   2) 各计划所有未作废（draft/confirmed）实测都落在各自新开灯窗内
 *   3) 两份拟改新开灯窗彼此不得重叠；且都不与同展品“其他”已批准/待复核计划重叠
 *   4) 按自然年：同时以两条新窗口各自“未被已确认实测覆盖部分”的估算量替换各自旧残余，
 *      任一年超过年度上限即超额（未登记上限的年份也算冲突）
 *
 * 返回 {
 *   ok, entries: [{ plan, adjustment, windows, conflicts:{notApproved,notStarted,outsideMeasurements},
 *                   oldResidueYearly, newResidueYearly, original, proposed }],
 *   conflicts: { pairOverlaps, overlappingPlans, overflows, missingLimits },
 *   occupiedWithoutPlans, yearlyReport
 * }
 */
async function evaluatePairAdjustment(client, exhibitId, adjA, adjB, nowMs = Date.now()) {
  const planA = await getPlan(client, adjA.plan_id);
  const planB = await getPlan(client, adjB.plan_id);
  const ordered = [
    { plan: planA, adjustment: adjA },
    { plan: planB, adjustment: adjB },
  ].sort((x, y) => x.plan.id - y.plan.id);

  const globalConflicts = {
    pairOverlaps: [],
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  const entries = [];
  for (const item of ordered) {
    const { plan, adjustment } = item;
    const targetWindows = adjustmentWindows(adjustment);
    const ownConflicts = {
      notApproved: plan.status !== 'approved',
      notStarted: !planNotStarted(plan, nowMs),
      outsideMeasurements: [],
    };

    // 1) 未作废实测必须完整落在各自新开灯窗内（仅核对本计划的实测）
    const measRows = await getNonAnnulledMeasurements(client, plan.id);
    ownConflicts.outsideMeasurements = outsideMeasurementsReport(measRows, targetWindows);

    // 2) 新窗口未被已确认实测覆盖部分的估算残余（draft 不计量）
    const newResidueYearly = residueYearlyFromWindows(
      targetWindows,
      measurementIntervals(measRows, { confirmedOnly: true }),
      Number(adjustment.estimated_lux)
    );

    // 原残余按年（与 computeOccupancy 口径一致）
    const oldResidueYearly = residueYearlyFromWindows(
      planWindows(plan),
      await getPlanConfirmedIntervals(client, plan.id),
      Number(plan.estimated_lux)
    );

    entries.push({
      plan,
      adjustment,
      windows: targetWindows,
      conflicts: ownConflicts,
      oldResidueYearly,
      newResidueYearly,
      original: planOriginalValues(plan),
      proposed: adjustmentProposedValues(adjustment),
    });
  }

  const [entry0, entry1] = entries;

  // 3) 两份拟改窗口彼此不得重叠
  if (anyIntersect(entry0.windows, entry1.windows)) {
    globalConflicts.pairOverlaps.push({
      planIds: [entry0.plan.id, entry1.plan.id],
      adjustmentIds: [entry0.adjustment.id, entry1.adjustment.id],
      titles: [entry0.plan.title, entry1.plan.title],
    });
  }

  // 4) 与同展品“其他”已批准/待复核计划（不含这两条）的开灯时刻重叠
  const others = await getOccupyingPlans(client, exhibitId, entries.map((e) => e.plan.id));
  for (const other of others) {
    for (const entry of entries) {
      if (planOverlaps(entry.windows, other)) {
        globalConflicts.overlappingPlans.push({
          planId: entry.plan.id,
          adjustmentId: entry.adjustment.id,
          planTitle: entry.plan.title,
          otherId: other.id,
          otherTitle: other.title,
          otherStatus: other.status,
          otherStartDate: dateYmd(other.start_date),
          otherEndDate: dateYmd(other.end_date),
        });
      }
    }
  }

  // 5) 按自然年同时替换两条估算残余后的额度核算
  const occupancy = await computeOccupancy(client, exhibitId, {
    excludePlanIds: entries.map((e) => e.plan.id),
  });
  const limits = occupancy.limits;
  const occupiedWithoutPlans = occupancy.used;

  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupiedWithoutPlans),
    ...entries.flatMap((e) => Object.keys(e.oldResidueYearly)),
    ...entries.flatMap((e) => Object.keys(e.newResidueYearly)),
  ].map(Number));
  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const otherUsed = round3(occupiedWithoutPlans[key] || 0);
    const old0 = round3(entry0.oldResidueYearly[key] || 0);
    const old1 = round3(entry1.oldResidueYearly[key] || 0);
    const new0 = round3(entry0.newResidueYearly[key] || 0);
    const new1 = round3(entry1.newResidueYearly[key] || 0);
    const oldTotal = round3(old0 + old1);
    const newTotal = round3(new0 + new1);
    const projected = round3(otherUsed + new0 + new1);
    const row = {
      year,
      limit,
      usedByOthers: otherUsed,
      oldResidues: {
        [entry0.plan.id]: old0,
        [entry1.plan.id]: old1,
      },
      newResidues: {
        [entry0.plan.id]: new0,
        [entry1.plan.id]: new1,
      },
      oldResidueTotal: oldTotal,
      newResidueTotal: newTotal,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 任一新残余占用了该年却没登记上限 -> 冲突
      if (new0 > 0 || new1 > 0) globalConflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      globalConflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    entries.every((e) => !e.conflicts.notApproved && !e.conflicts.notStarted &&
      e.conflicts.outsideMeasurements.length === 0) &&
    globalConflicts.pairOverlaps.length === 0 &&
    globalConflicts.overlappingPlans.length === 0 &&
    globalConflicts.overflows.length === 0 &&
    globalConflicts.missingLimits.length === 0;

  return {
    ok,
    entries,
    conflicts: globalConflicts,
    occupiedWithoutPlans,
    yearlyReport,
  };
}

/** 某计划落在其窗口内的已确认实测区间（成对核算的旧残余口径：本计划自身的已确认实测）。 */
async function getPlanConfirmedIntervals(client, planId) {
  const { rows } = await client.query(
    `SELECT start_ts, end_ts FROM measurements
      WHERE plan_id = $1 AND status = 'confirmed'
      ORDER BY id`,
    [planId]
  );
  return rows.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));
}

/**
 * 给计划行附加：
 *  - notStarted：首个开灯时刻是否尚未到来
 *  - pendingAdjustment：当前待审调整申请（含拟改值试算 preview，可选）
 * plans: 单行或数组；withPreview 时会做完整试算（调用方须在展品事务/只读连接均可）。
 */
async function decoratePlans(client, plansInput, { withPreview = false, nowMs = Date.now() } = {}) {
  const list = Array.isArray(plansInput) ? plansInput : [plansInput];
  if (list.length === 0) return plansInput;
  const pendingMap = await getPendingAdjustments(client, list.map((p) => p.id));
  for (const plan of list) {
    plan.not_started = plan.status === 'approved' && planNotStarted(plan, nowMs);
    plan.notStarted = plan.not_started;
    const adj = pendingMap.get(Number(plan.id));
    if (adj) {
      const base = serializeAdjustment(adj);
      if (withPreview && plan.status === 'approved' && planNotStarted(plan, nowMs)) {
        const evalResult = await evaluateAdjustment(client, plan, adj, nowMs);
        base.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      }
      plan.pending_adjustment = base;
      plan.pendingAdjustment = base;
    } else {
      plan.pending_adjustment = null;
      plan.pendingAdjustment = null;
    }
  }
  return plansInput;
}

/** 调整申请的对外字段（驼峰）。 */
function serializeAdjustment(a) {
  if (!a) return null;
  return {
    id: a.id,
    planId: a.plan_id,
    exhibitId: a.exhibit_id,
    startDate: dateYmd(a.start_date),
    endDate: dateYmd(a.end_date),
    periods: normalizePeriods(a.light_periods),
    estimatedLux: Number(a.estimated_lux),
    reason: a.reason,
    status: a.status,
    rejectReason: a.reject_reason,
    createdBy: a.created_by,
    creatorName: a.creator_name || null,
    reviewedBy: a.reviewed_by,
    reviewerName: a.reviewer_name || null,
    reviewedAt: a.reviewed_at,
    createdAt: a.created_at,
    planTitle: a.plan_title || null,
    exhibitName: a.exhibit_name || null,
    // 原值（列表/详情联表带出处）
    original: a.original || null,
  };
}

// ---------------------------------------------------------------------------
// 下调年度上限：预演核算
// ---------------------------------------------------------------------------

/**
 * 预演把某展品某自然年上限降到 proposedLimit 后的额度核算（不写库）。
 * 返回内容：
 *  - 该年已确认实测（逐条，含按年剂量）
 *  - 各已批准/待复核计划在该年的估算残余
 *  - 预计合计/剩余/超额量
 *  - 超额时仍在该年有估算残余且尚未开始的已批准计划（flagCandidates）
 *  - fingerprint：当前占用快照指纹（供预演凭证校验“额度或相关占用是否已变化”）
 *
 * 口径与 computeOccupancy 完全一致（已确认实测 + 计划估算残余）。
 * 该年尚未登记上限时返回 400（下调必须针对既有上限；登记新上限请用 limits 接口）。
 */
async function computeLimitPreview(client, exhibitId, year, proposedLimit, { nowMs = Date.now() } = {}) {
  const yearStr = String(year);
  const { rows: limitRows } = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1 AND year = $2 FOR UPDATE',
    [exhibitId, year]
  );
  if (limitRows.length === 0) {
    throw new ValidationError(`${year} 年尚未登记年度上限，不能下调；请先登记该年度上限`);
  }
  const currentLimit = round3(Number(limitRows[0].limit_lxh));

  const occupancy = await computeOccupancy(client, exhibitId);
  const used = round3(occupancy.used[yearStr] || 0);
  const excess = used - proposedLimit > 0.005 ? round3(used - proposedLimit) : 0;

  // 该年已确认实测（仅列在该年剂量 > 0 的，避免无关年份噪音）
  const confirmedMeasurements = occupancy.sources
    .filter((s) => s.kind === 'measurement' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => ({
      id: s.id,
      planId: s.planId,
      start: s.start,
      end: s.end,
      lux: s.lux,
      yearDose: round3(s.yearly[yearStr]),
      yearly: s.yearly,
    }));

  // 各已批准/待复核计划在该年的估算残余
  const planById = new Map(occupancy.plans.map((p) => [p.id, p]));
  const planResidues = occupancy.sources
    .filter((s) => s.kind === 'plan' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => {
      const firstStart = Math.min(...planWindows(planById.get(s.id)).map((w) => w.start));
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        periods: normalizePeriods(s.periods),
        lux: s.lux,
        yearResidue: round3(s.yearly[yearStr]),
        firstStart: tsToWallString(firstStart),
        notStarted: s.status === 'approved' && firstStart > nowMs,
      };
    });

  // 超额时：仍在该年有估算残余、且尚未开始的已批准计划（下调成功后将转待复核）
  const flagCandidates = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && p.notStarted)
    : [];
  // 已开始但仍占用该年残余的计划：不转状态，但剩余超额仍如实显示
  const startedResiduePlans = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && !p.notStarted)
    : [];

  // ---- 凭证指纹快照：覆盖上限/未作废实测/占用计划/时刻 ----
  const { rows: allMeasRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, actual_lux, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [exhibitId]
  );
  const fingerprintMeasures = allMeasRows.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
    status: m.status,
  }));
  const fingerprintPlans = occupancy.plans.map((p) => ({
    id: p.id,
    status: p.status,
    startDate: dateYmd(p.start_date),
    endDate: dateYmd(p.end_date),
    periods: normalizePeriods(p.light_periods),
    lux: Number(p.estimated_lux),
    yearResidue: round3(
      (occupancy.sources.find((s) => s.kind === 'plan' && s.id === p.id) || { yearly: {} })
        .yearly[yearStr] || 0
    ),
  }));
  // 此刻已开始（首个开灯时刻已过）的已批准计划 id：时间相关状态仅体现在这里
  const startedPlanIds = occupancy.plans
    .filter((p) => p.status === 'approved')
    .filter((p) => Math.min(...planWindows(p).map((w) => w.start)) <= nowMs)
    .map((p) => p.id)
    .sort((a, b) => a - b);

  return {
    exhibitId,
    year,
    currentLimit,
    proposedLimit: round3(proposedLimit),
    used,
    remaining: round3(proposedLimit - used),
    excess,
    over: excess > 0,
    confirmedMeasurements,
    planResidues,
    flagCandidates,
    startedResiduePlans,
    signature: {
      currentLimit,
      measurements: fingerprintMeasures,
      plans: fingerprintPlans,
      startedPlanIds,
    },
  };
}

module.exports = {
  ACTIVE_PLAN_STATUSES,
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  planWindows,
  planResidueYearly,
  findOverlappingMeasurement,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  validateMeasurementWindow,
  plansToFlag,
  computeLimitPreview,
  yearOfTs,
  // 调整申请
  normalizeScheduleInput,
  getPendingAdjustment,
  getPendingAdjustments,
  planFirstStart,
  planNotStarted,
  adjustmentWindows,
  evaluateAdjustment,
  evaluatePairAdjustment,
  planOriginalValues,
  adjustmentProposedValues,
  decoratePlans,
  serializeAdjustment,
};
