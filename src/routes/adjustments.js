'use strict';

const express = require('express');
const { withExhibitTransaction, query } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, AuthError } = require('../validation');
const {
  lockExhibit,
  getPlan,
  getPendingAdjustment,
  decoratePlans,
  evaluateAdjustment,
  evaluatePairAdjustment,
  normalizeScheduleInput,
  serializeAdjustment,
  planNotStarted,
  planOriginalValues,
  adjustmentProposedValues,
} = require('../service');
const { exhibitDetail } = require('./exhibits');

const router = express.Router();

router.use(requireAuth);

/** 按用户 id 集合批量加载显示名，返回 Map<id, display_name>。q 为查询函数或事务 client。 */
async function loadUserNames(q, idSet) {
  const ids = [...idSet];
  const map = new Map();
  if (ids.length === 0) return map;
  const run = typeof q === 'function' ? q : q.query.bind(q);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await run(
    `SELECT id, display_name FROM users WHERE id IN (${placeholders})`,
    ids
  );
  for (const u of rows) map.set(Number(u.id), u.display_name);
  return map;
}

/** 调整申请列表：可按 planId / exhibitId / status 过滤；带 preview=1 时附带试算。 */
router.get('/', async (req, res, next) => {
  try {
    const planId = req.query.planId ? Number(req.query.planId) : null;
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const status =
      req.query.status && ['pending', 'approved', 'rejected', 'withdrawn'].includes(String(req.query.status))
        ? String(req.query.status)
        : null;
    const withPreview = String(req.query.preview || '') === '1';

    // 先取申请行（避免部分驱动对“连接 + 过滤 + 排序”组合的实现限制），再补展示名
    const { rows } = await query(
      `SELECT * FROM plan_adjustments a
        WHERE ($1::bigint IS NULL OR a.plan_id = $1)
          AND ($2::bigint IS NULL OR a.exhibit_id = $2)
          AND ($3::text IS NULL OR a.status = $3)
        ORDER BY a.id DESC
        LIMIT 1000`,
      [Number.isInteger(planId) ? planId : null,
       Number.isInteger(exhibitId) ? exhibitId : null,
       status]
    );

    let adjustments = rows.map(serializeAdjustment);
    const rawById = new Map(rows.map((row) => [row.id, row]));

    // 补计划/展品/操作人展示名
    const nameIds = new Set();
    for (const row of rows) {
      if (row.created_by) nameIds.add(Number(row.created_by));
      if (row.reviewed_by) nameIds.add(Number(row.reviewed_by));
    }
    const nameMap = await loadUserNames(query, nameIds);
    const { rows: adjPlans } = await query(
      `SELECT id, exhibit_id, title FROM plans
        WHERE id IN (SELECT DISTINCT plan_id FROM plan_adjustments
                      WHERE id IN (${rows.map((_, i) => `$${i + 1}`).join(',')}))`,
      rows.map((row) => row.id)
    );
    const adjPlanById = new Map(adjPlans.map((p) => [Number(p.id), p]));
    const exhibitNameIds = [...new Set(adjPlans.map((p) => Number(p.exhibit_id)))];
    let exhibitNameMap = new Map();
    if (exhibitNameIds.length > 0) {
      const ph = exhibitNameIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: exRows } = await query(
        `SELECT id, name FROM exhibits WHERE id IN (${ph})`,
        exhibitNameIds
      );
      exhibitNameMap = new Map(exRows.map((e) => [Number(e.id), e.name]));
    }
    for (const a of adjustments) {
      const p = adjPlanById.get(a.planId);
      a.planTitle = p ? p.title : null;
      a.exhibitName = p ? exhibitNameMap.get(Number(p.exhibit_id)) || null : null;
      const raw = rawById.get(a.id);
      a.creatorName = raw.created_by ? nameMap.get(Number(raw.created_by)) || null : null;
      a.reviewerName = raw.reviewed_by ? nameMap.get(Number(raw.reviewed_by)) || null : null;
    }

    // 原值（来自所属计划当前值）
    if (adjustments.length > 0) {
      const planIds = [...new Set(adjustments.map((a) => a.planId))];
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows: planRows } = await query(
        `SELECT id, start_date, end_date, light_periods, estimated_lux, status, title FROM plans
          WHERE id IN (${placeholders})`,
        planIds
      );
      const planById = new Map(planRows.map((p) => [Number(p.id), p]));
      adjustments = adjustments.map((a) => {
        const p = planById.get(a.planId);
        a.original = p
          ? {
              title: p.title,
              status: p.status,
              startDate: String(p.start_date).slice(0, 10),
              endDate: String(p.end_date).slice(0, 10),
              periods: p.light_periods,
              estimatedLux: Number(p.estimated_lux),
            }
          : null;
        return a;
      });
    }

    // 待审申请附带拟改值试算（原值 vs 拟改值、冲突明细）
    if (withPreview) {
      const pendings = adjustments.filter((a) => a.status === 'pending');
      // 按展品分组，在展品事务中逐组试算（复用行锁串行化，避免脏读干扰）
      const byExhibit = new Map();
      for (const a of pendings) {
        if (!byExhibit.has(a.exhibitId)) byExhibit.set(a.exhibitId, []);
        byExhibit.get(a.exhibitId).push(a);
      }
      for (const [exId, list] of byExhibit) {
        await withExhibitTransaction(exId, async (client) => {
          await lockExhibit(client, exId);
          for (const a of list) {
            const plan = await getPlan(client, a.planId);
            const evalResult = await evaluateAdjustment(client, plan, rawById.get(a.id));
            a.preview = {
              ok: evalResult.ok,
              conflicts: evalResult.conflicts,
              oldResidueYearly: evalResult.oldResidueYearly,
              newResidueYearly: evalResult.newResidueYearly,
              yearlyReport: evalResult.yearlyReport,
            };
          }
        });
      }
    }

    res.json({ adjustments });
  } catch (err) {
    next(err);
  }
});

// 调整申请详情（含原值与拟改值试算）
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await query(`SELECT * FROM plan_adjustments WHERE id = $1`, [id]);
    if (rows.length === 0) throw new ValidationError('调整申请不存在');
    const rawAdjustment = rows[0];
    const adjustment = serializeAdjustment(rawAdjustment);
    const nameMap = await loadUserNames(query, new Set(
      [rawAdjustment.created_by, rawAdjustment.reviewed_by].filter(Boolean).map(Number)
    ));
    adjustment.creatorName = rawAdjustment.created_by
      ? nameMap.get(Number(rawAdjustment.created_by)) || null : null;
    adjustment.reviewerName = rawAdjustment.reviewed_by
      ? nameMap.get(Number(rawAdjustment.reviewed_by)) || null : null;
    const { rows: titleRows } = await query(
      `SELECT p.title AS plan_title, e.name AS exhibit_name
         FROM plans p JOIN exhibits e ON e.id = p.exhibit_id
        WHERE p.id = $1`,
      [rawAdjustment.plan_id]
    );
    if (titleRows[0]) {
      adjustment.planTitle = titleRows[0].plan_title;
      adjustment.exhibitName = titleRows[0].exhibit_name;
    }
    const detail = await withExhibitTransaction(adjustment.exhibitId, async (client) => {
      await lockExhibit(client, adjustment.exhibitId);
      const plan = await getPlan(client, adjustment.planId);
      adjustment.original = {
        title: plan.title,
        status: plan.status,
        startDate: String(plan.start_date).slice(0, 10),
        endDate: String(plan.end_date).slice(0, 10),
        periods: plan.light_periods,
        estimatedLux: Number(plan.estimated_lux),
      };
      if (adjustment.status === 'pending') {
        const evalResult = await evaluateAdjustment(client, plan, rawAdjustment);
        adjustment.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      }
      return adjustment;
    });
    res.json({ adjustment: detail });
  } catch (err) {
    next(err);
  }
});

/**
 * 布展员提交调整申请：
 *  - 仅 installer
 *  - 计划必须存在、已批准且尚未开始
 *  - 同一计划同时只允许一份待审申请（重复明确拒绝）
 *  - 新展期/开灯时段/照度走与建计划一致的中文校验（无效时段 400）
 * 待审期间原计划继续占用额度（此处不改计划）。
 */
router.post('/', requireRole('installer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const planId = Number(body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = normalizeScheduleInput(body);
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;

    const result = await withExhibitTransaction((await getPlan({ query }, planId)).exhibit_id,
      async (client) => {
        const prePlan = await getPlan(client, planId);
        await lockExhibit(client, prePlan.exhibit_id);
        // 锁后重读最新状态
        const plan = await getPlan(client, planId);

        if (plan.status !== 'approved') {
          throw new ValidationError(
            `只有已批准且尚未开始的计划才能提交调整申请（当前状态：${plan.status}）`
          );
        }
        if (!planNotStarted(plan)) {
          throw new ValidationError('计划已开始，不能再提交调整申请');
        }
        const existing = await getPendingAdjustment(client, planId);
        if (existing) {
          throw new ConflictError(
            `该计划已有待审调整申请 #${existing.id}，请先撤回后再重新提交`,
            { existingAdjustmentId: existing.id }
          );
        }

        const inserted = await client.query(
          `INSERT INTO plan_adjustments
             (plan_id, exhibit_id, start_date, end_date, light_periods, estimated_lux,
              reason, status, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'pending', $8)
           RETURNING *`,
          [
            planId,
            plan.exhibit_id,
            input.startDate,
            input.endDate,
            JSON.stringify(input.periodSpecs),
            input.estimatedLux,
            reason,
            req.sessionUser.userId,
          ]
        );
        await recordAudit(client, req.sessionUser, 'plan.adjustment.submit',
          'plan_adjustment', inserted.rows[0].id, {
            planId,
            exhibitId: plan.exhibit_id,
            original: {
              startDate: String(plan.start_date).slice(0, 10),
              endDate: String(plan.end_date).slice(0, 10),
              periods: plan.light_periods,
              estimatedLux: Number(plan.estimated_lux),
            },
            proposed: {
              startDate: input.startDate,
              endDate: input.endDate,
              periods: input.periodSpecs,
              estimatedLux: input.estimatedLux,
            },
            reason,
          });

        // 回传试算，便于页面展示原值与拟改值（申请本身保持 pending）
        const adj = inserted.rows[0];
        const evalResult = await evaluateAdjustment(client, plan, adj);
        const adjustment = serializeAdjustment(adj);
        adjustment.original = {
          title: plan.title,
          status: plan.status,
          startDate: String(plan.start_date).slice(0, 10),
          endDate: String(plan.end_date).slice(0, 10),
          periods: plan.light_periods,
          estimatedLux: Number(plan.estimated_lux),
        };
        adjustment.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
        return adjustment;
      });

    res.status(201).json({ adjustment: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 拟改值试算（不提交）：任意登录用户可对已批准且未开始的计划试算一组新参数，
 * 供提交前页面展示原值/拟改值与冲突提示。不写库。
 */
router.post('/preview', requireRole('installer'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const planId = Number(body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const input = normalizeScheduleInput(body);

    const result = await withExhibitTransaction((await getPlan({ query }, planId)).exhibit_id,
      async (client) => {
        const prePlan = await getPlan(client, planId);
        await lockExhibit(client, prePlan.exhibit_id);
        const plan = await getPlan(client, planId);
        if (plan.status !== 'approved') {
          throw new ValidationError(`只有已批准且尚未开始的计划才能试算（当前状态：${plan.status}）`);
        }
        if (!planNotStarted(plan)) throw new ValidationError('计划已开始，不能再调整');
        const evalResult = await evaluateAdjustment(client, plan, {
          start_date: input.startDate,
          end_date: input.endDate,
          light_periods: input.periodSpecs,
          estimated_lux: input.estimatedLux,
        });
        return {
          proposed: {
            startDate: input.startDate,
            endDate: input.endDate,
            periods: input.periodSpecs,
            estimatedLux: input.estimatedLux,
          },
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      });
    res.json({ preview: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 成对核准（两份待审调整申请同时替换窗口）
// ---------------------------------------------------------------------------

/** 解析成对请求中的两个申请编号：接受 {a,b} 或 {adjustmentIds:[x,y]}，返回 [id1,id2]。 */
function parsePairIds(body) {
  const raw = Array.isArray(body.adjustmentIds)
    ? body.adjustmentIds.slice(0, 3)
    : [body.a, body.b].filter((v) => v !== undefined && v !== null && v !== '');
  const ids = raw.map((v) => Number(v));
  if (raw.length !== 2 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ValidationError('请提供两个不同的调整申请编号（adjustmentIds 或 a/b）');
  }
  if (ids[0] === ids[1]) {
    throw new ValidationError('两份申请编号必须不同；成对核准要求输入两个不同申请编号');
  }
  return ids;
}

/**
 * 结构性预校验（锁外、只读）：两份申请都存在、都待审、同展品且关联不同计划。
 * 不满足时直接拒绝并指出原因。返回锁定顺序的 [adj1, adj2]（按 id 排序，避免锁顺序问题）。
 */
async function loadPairForCheck(ids) {
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await query(
    `SELECT * FROM plan_adjustments WHERE id IN (${placeholders}) ORDER BY id`,
    ids
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of ids) {
    if (!byId.has(id)) throw new ValidationError(`调整申请 #${id} 不存在`);
  }
  const [adj1, adj2] = ids
    .slice()
    .sort((x, y) => x - y)
    .map((id) => byId.get(id));
  if (adj1.status !== 'pending' || adj2.status !== 'pending') {
    const closed = [adj1, adj2].filter((a) => a.status !== 'pending');
    const names = { approved: '已核准', rejected: '已驳回', withdrawn: '已撤回' };
    throw new ValidationError(
      `调整申请 ${closed.map((a) => `#${a.id}（${names[a.status] || a.status}）`).join('、')} 已结案，不能成对核准`
    );
  }
  if (Number(adj1.plan_id) === Number(adj2.plan_id)) {
    throw new ValidationError(
      `两份申请 #${adj1.id}、#${adj2.id} 关联同一计划 #${adj1.plan_id}；成对核准要求两份申请分属两条不同计划`
    );
  }
  if (Number(adj1.exhibit_id) !== Number(adj2.exhibit_id)) {
    throw new ValidationError(
      `两份申请 #${adj1.id}、#${adj2.id} 分属不同展品（#${adj1.exhibit_id}、#${adj2.exhibit_id}）；成对核准仅限同一展品`
    );
  }
  return [adj1, adj2];
}

/** 把成对核对结果整理成对外 preview 形态。 */
function pairPreviewPayload(evalResult) {
  return {
    ok: evalResult.ok,
    adjustments: evalResult.entries.map((e) => ({
      adjustmentId: e.adjustment.id,
      planId: e.plan.id,
      planTitle: e.plan.title,
      status: e.plan.status,
      original: e.original,
      proposed: e.proposed,
      conflicts: e.conflicts,
      oldResidueYearly: e.oldResidueYearly,
      newResidueYearly: e.newResidueYearly,
    })),
    conflicts: evalResult.conflicts,
    yearlyReport: evalResult.yearlyReport,
  };
}

/** 汇总成对核对失败原因（中文），用于 409 错误信息。 */
function pairConflictMessage(ids, evalResult) {
  const parts = [];
  for (const e of evalResult.entries) {
    const c = e.conflicts;
    if (c.notApproved) parts.push(`计划 #${e.plan.id} 已不是“已批准”状态（当前：${e.plan.status}）`);
    if (c.notStarted) parts.push(`计划 #${e.plan.id} 已经开始`);
    for (const m of c.outsideMeasurements) {
      parts.push(
        `计划 #${e.plan.id} 的未作废实测 #${m.id}（${m.start} ~ ${m.end}，${m.status}）不在新开灯窗内`
      );
    }
  }
  for (const p of evalResult.conflicts.pairOverlaps) {
    parts.push(`两份拟改窗口（计划「${p.titles[0]}」(#${p.planIds[0]}) 与「${p.titles[1]}」(#${p.planIds[1]})）开灯时间彼此重叠`);
  }
  for (const p of evalResult.conflicts.overlappingPlans) {
    parts.push(
      `拟改计划「${p.planTitle}」(#${p.planId}) 与同展品${p.otherStatus === 'pending_review' ? '待复核' : '已批准'}` +
      `计划「${p.otherTitle}」(#${p.otherId}) 开灯时间重叠`
    );
  }
  for (const y of evalResult.conflicts.missingLimits) parts.push(`${y} 年尚未登记年度额度`);
  for (const o of evalResult.conflicts.overflows) {
    const c0 = o.oldResidues;
    const n0 = o.newResidues;
    const detail = Object.keys(n0)
      .map((pid) => `计划 #${pid}：原残余 ${c0[pid]}，拟改残余 ${n0[pid]}`)
      .join('；');
    parts.push(
      `${o.year} 年：上限 ${o.limit}，其他占用 ${o.usedByOthers}，${detail}，` +
        `合计 ${o.projected}，超额 ${o.excess} lx·h`
    );
  }
  return `成对核准申请 #${ids[0]}、#${ids[1]} 未通过核对：` + parts.join('；');
}

/**
 * 成对试算（不写库）：保管员输入两个不同申请编号，
 * 返回两份拟改窗口同时替换后的重叠/窗外实测/按年额度核算结果。
 */
router.post('/pair/preview', requireRole('conservator'), async (req, res, next) => {
  try {
    const ids = parsePairIds(req.body || {});
    const [adj1, adj2] = await loadPairForCheck(ids);
    const result = await withExhibitTransaction(Number(adj1.exhibit_id), async (client) => {
      await lockExhibit(client, Number(adj1.exhibit_id));
      // 锁内重读申请，确保拿到最新状态
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rows = await client.query(
        `SELECT * FROM plan_adjustments WHERE id IN (${ph}) ORDER BY id FOR UPDATE`,
        ids
      );
      const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
      const a1 = byId.get(ids[0]);
      const a2 = byId.get(ids[1]);
      if (!a1 || !a2) throw new ValidationError('调整申请不存在');
      if (a1.status !== 'pending' || a2.status !== 'pending') {
        throw new ValidationError('两份申请必须均为待审状态才能成对试算');
      }
      const evalResult = await evaluatePairAdjustment(
        client, Number(adj1.exhibit_id), a1, a2
      );
      return { adjustmentIds: ids, exhibitId: Number(adj1.exhibit_id), ...pairPreviewPayload(evalResult) };
    });
    res.json({ pairPreview: result });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员成对核准：在展品锁事务内重新核对全部规则，
 * 全部通过才原子更新两条计划、结案两份申请并记审计；
 * 任一失败则两份申请仍待审、计划与额度不变（事务回滚，返回 409）。
 */
router.post('/pair/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const ids = parsePairIds(req.body || {});
    const [preAdj1, preAdj2] = await loadPairForCheck(ids);
    const exhibitId = Number(preAdj1.exhibit_id);

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rows = await client.query(
        `SELECT * FROM plan_adjustments WHERE id IN (${ph}) ORDER BY id FOR UPDATE`,
        ids
      );
      const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
      const adj1 = byId.get(ids[0]);
      const adj2 = byId.get(ids[1]);
      if (!adj1 || !adj2) throw new ValidationError('调整申请不存在');
      if (adj1.status !== 'pending' || adj2.status !== 'pending') {
        throw new ValidationError('两份申请必须均为待审状态才能成对核准');
      }

      const evalResult = await evaluatePairAdjustment(client, exhibitId, adj1, adj2);
      if (!evalResult.ok) {
        // 任一失败：事务回滚，两份申请保持 pending，计划与额度均不变
        throw new ConflictError(pairConflictMessage(ids, evalResult), {
          adjustmentIds: ids,
          pairPreview: pairPreviewPayload(evalResult),
        });
      }

      // 全部通过：原子更新两条计划 + 结案两份申请 + 审计
      for (const e of evalResult.entries) {
        const { plan, adjustment } = e;
        await client.query(
          `UPDATE plans
              SET start_date = $2, end_date = $3, light_periods = $4::jsonb,
                  estimated_lux = $5, review_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [
            plan.id,
            adjustment.start_date,
            adjustment.end_date,
            JSON.stringify(adjustment.light_periods),
            adjustment.estimated_lux,
          ]
        );
        await client.query(
          `UPDATE plan_adjustments
              SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
            WHERE id = $1`,
          [adjustment.id, req.sessionUser.userId]
        );
        await recordAudit(client, req.sessionUser, 'plan.adjustment.pair_approve',
          'plan_adjustment', adjustment.id, {
            pairAdjustmentIds: ids,
            planId: plan.id,
            exhibitId,
            oldResidueYearly: e.oldResidueYearly,
            newResidueYearly: e.newResidueYearly,
            oldValues: planOriginalValues(plan),
            newValues: adjustmentProposedValues(adjustment),
          });
        await recordAudit(client, req.sessionUser, 'plan.update_via_pair_adjustment',
          'plan', plan.id, {
            pairAdjustmentIds: ids,
            oldResidueYearly: e.oldResidueYearly,
            newResidueYearly: e.newResidueYearly,
          });
      }

      return exhibitDetail(client, exhibitId, { lock: true });
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/** 保管员批准调整申请。 */
router.post('/:id/approve', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await query('SELECT exhibit_id, plan_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const exhibitId = row.rows[0].exhibit_id;

    const detail = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能批准`);
      }
      const plan = await getPlan(client, adj.plan_id);

      // 批准时在展品锁事务内重新核对全部规则
      const evalResult = await evaluateAdjustment(client, plan, adj);
      if (!evalResult.ok) {
        const c = evalResult.conflicts;
        const parts = [];
        if (c.notApproved) parts.push(`计划已不是“已批准”状态（当前：${plan.status}）`);
        if (c.notStarted) parts.push('计划已经开始');
        for (const m of c.outsideMeasurements) {
          parts.push(
            `未作废实测 #${m.id}（${m.start} ~ ${m.end}，${m.status}）不在新开灯窗内`
          );
        }
        for (const p of c.overlappingPlans) {
          parts.push(`与同展品${p.status === 'pending_review' ? '待复核' : '已批准'}计划「${p.title}」(#${p.id}) 开灯时间重叠`);
        }
        for (const y of c.missingLimits) parts.push(`${y} 年尚未登记年度额度`);
        for (const o of c.overflows) {
          parts.push(
            `${o.year} 年：上限 ${o.limit}，其他占用 ${o.usedByOthers}，原残余 ${o.oldResidue}，` +
              `拟改残余 ${o.newResidue}，合计 ${o.projected}，超额 ${o.excess} lx·h`
          );
        }
        // 校验失败：申请保持待审，以便布展员撤回后重提；事务回滚，不改计划
        throw new ConflictError(`调整申请 #${id} 未通过核对：` + parts.join('；'), {
          adjustmentId: id,
          conflicts: c,
          yearlyReport: evalResult.yearlyReport,
        });
      }

      // 通过：原子更新计划 + 结案申请 + 审计
      await client.query(
        `UPDATE plans
            SET start_date = $2, end_date = $3, light_periods = $4::jsonb,
                estimated_lux = $5, review_reason = NULL, updated_at = now()
          WHERE id = $1`,
        [plan.id, adj.start_date, adj.end_date, JSON.stringify(adj.light_periods), adj.estimated_lux]
      );
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.approve',
        'plan_adjustment', id, {
          planId: plan.id,
          exhibitId: plan.exhibit_id,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          oldValues: {
            startDate: String(plan.start_date).slice(0, 10),
            endDate: String(plan.end_date).slice(0, 10),
            periods: plan.light_periods,
            estimatedLux: Number(plan.estimated_lux),
          },
          newValues: {
            startDate: String(adj.start_date).slice(0, 10),
            endDate: String(adj.end_date).slice(0, 10),
            periods: adj.light_periods,
            estimatedLux: Number(adj.estimated_lux),
          },
        });
      await recordAudit(client, req.sessionUser, 'plan.update_via_adjustment', 'plan', plan.id, {
        adjustmentId: id,
        oldResidueYearly: evalResult.oldResidueYearly,
        newResidueYearly: evalResult.newResidueYearly,
      });

      return exhibitDetail(client, plan.exhibit_id, { lock: true });
    });

    res.json(detail);
  } catch (err) {
    next(err);
  }
});

/** 保管员驳回调整申请：不改变计划，申请结案为 rejected。 */
router.post('/:id/reject', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reason =
      req.body && req.body.reason ? String(req.body.reason).slice(0, 1000) : null;
    const row = await query('SELECT exhibit_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const result = await withExhibitTransaction(row.rows[0].exhibit_id, async (client) => {
      await lockExhibit(client, row.rows[0].exhibit_id);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能驳回`);
      }
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'rejected', reject_reason = $2, reviewed_by = $3,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, reason, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.reject',
        'plan_adjustment', id, { planId: adj.plan_id, reason });

      const plan = await getPlan(client, adj.plan_id);
      const [decorated] = await decoratePlans(client, [plan]);
      return { ok: true, adjustmentId: id, plan: decorated };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** 布展员撤回自己的待审调整申请；保管员可撤回任何待审申请。撤回后可重新提交。 */
router.post('/:id/withdraw', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await query('SELECT exhibit_id FROM plan_adjustments WHERE id = $1', [id]);
    if (row.rows.length === 0) throw new ValidationError('调整申请不存在');
    const result = await withExhibitTransaction(row.rows[0].exhibit_id, async (client) => {
      await lockExhibit(client, row.rows[0].exhibit_id);
      const adjRows = await client.query('SELECT * FROM plan_adjustments WHERE id = $1 FOR UPDATE', [id]);
      const adj = adjRows.rows[0];
      if (!adj) throw new ValidationError('调整申请不存在');
      if (adj.status !== 'pending') {
        throw new ValidationError(`该调整申请当前状态（${adj.status}）不能撤回`);
      }
      const isOwner = Number(adj.created_by) === req.sessionUser.userId;
      const isConservator = req.sessionUser.role === 'conservator';
      if (!isOwner && !isConservator) {
        throw new AuthError('只能撤回自己提交的调整申请', 403);
      }
      await client.query(
        `UPDATE plan_adjustments
            SET status = 'withdrawn', reviewed_by = CASE WHEN $2 THEN $3 ELSE reviewed_by END,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, isConservator, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'plan.adjustment.withdraw',
        'plan_adjustment', id, { planId: adj.plan_id, byConservator: isConservator });

      const plan = await getPlan(client, adj.plan_id);
      const [decorated] = await decoratePlans(client, [plan]);
      return { ok: true, adjustmentId: id, plan: decorated };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
