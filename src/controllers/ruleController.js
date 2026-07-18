const Device = require('../models/Device');
const Rule = require('../models/Rule');
const { findConflictingRules } = require('../services/ruleEngine');

const CLAUSE_OPERATORS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'changed'];
const ACTION_TYPES = ['device_command', 'notify'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Same ownership-check pattern as assertRoomOwnership in deviceController,
 * just applied everywhere a rule can reference a device — trigger,
 * conditions, and device_command action targets can each be a different
 * device, so this gets called several times per rule. */
async function assertDeviceOwnership(deviceId, ownerId) {
  if (!deviceId) throw badRequest('device is required');
  const device = await Device.findOne({ _id: deviceId, owner: ownerId });
  if (!device) throw badRequest(`device ${deviceId} not found`);
  return device;
}

function validateClauseShape(clause, label) {
  if (!clause || typeof clause !== 'object') throw badRequest(`${label} is required`);
  if (!clause.capability || typeof clause.capability !== 'string') {
    throw badRequest(`${label}.capability is required`);
  }
  if (!CLAUSE_OPERATORS.includes(clause.operator)) {
    throw badRequest(`${label}.operator must be one of: ${CLAUSE_OPERATORS.join(', ')}`);
  }
  if (clause.operator !== 'changed' && clause.value === undefined) {
    throw badRequest(`${label}.value is required unless operator is 'changed'`);
  }
}

async function buildClause(raw, ownerId, label) {
  validateClauseShape(raw, label);
  const device = await assertDeviceOwnership(raw.device, ownerId);
  return {
    device: device._id,
    capability: raw.capability,
    operator: raw.operator,
    value: raw.operator === 'changed' ? undefined : raw.value,
  };
}

async function buildAction(raw, ownerId, index) {
  if (!raw || !ACTION_TYPES.includes(raw.type)) {
    throw badRequest(`actions[${index}].type must be one of: ${ACTION_TYPES.join(', ')}`);
  }

  if (raw.type === 'device_command') {
    const device = await assertDeviceOwnership(raw.device, ownerId);
    if (!raw.capability) throw badRequest(`actions[${index}].capability is required for device_command`);
    if (raw.value === undefined) throw badRequest(`actions[${index}].value is required for device_command`);
    return { type: 'device_command', device: device._id, capability: raw.capability, value: raw.value };
  }

  // notify
  if (!raw.message || !raw.message.trim()) {
    throw badRequest(`actions[${index}].message is required for notify`);
  }
  return { type: 'notify', message: raw.message.trim() };
}

/**
 * POST /api/rules
 * body: { name, trigger, conditions?, actions, maxChainDepth?, enabled? }
 * trigger/conditions: { device, capability, operator, value? }
 * actions: [{ type: 'device_command', device, capability, value } | { type: 'notify', message }]
 */
async function createRule(req, res) {
  try {
    const { name, trigger, conditions = [], actions = [], maxChainDepth, enabled } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(conditions)) return res.status(400).json({ error: 'conditions must be an array' });
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'at least one action is required' });
    }

    const builtTrigger = await buildClause(trigger, req.userId, 'trigger');

    const builtConditions = [];
    for (const c of conditions) {
      builtConditions.push(await buildClause(c, req.userId, 'conditions[]'));
    }

    const builtActions = [];
    for (let i = 0; i < actions.length; i++) {
      builtActions.push(await buildAction(actions[i], req.userId, i));
    }

    const rule = await Rule.create({
      name: name.trim(),
      owner: req.userId,
      enabled: enabled === undefined ? true : Boolean(enabled),
      trigger: builtTrigger,
      conditions: builtConditions,
      actions: builtActions,
      ...(maxChainDepth !== undefined ? { maxChainDepth } : {}),
    });

    // Populate device refs so this response matches listRules' shape —
    // the Android client's ClauseDto/ActionDto expect device to be an
    // object ({_id, name, type}), not a raw ObjectId string.
    await rule.populate([
      { path: 'trigger.device', select: 'name type' },
      { path: 'conditions.device', select: 'name type' },
      { path: 'actions.device', select: 'name type' },
    ]);

    const response = { rule };
    if (rule.enabled) {
      const conflicts = await findConflictingRules(rule, req.userId, rule._id);
      if (conflicts.length) {
        response.warnings = conflicts.map(
          (c) => `Conflicts with rule "${c.ruleName}" (${c.ruleId}): ${c.reason}`
        );
      }
    }

    return res.status(201).json(response);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[rules] create error:', err.message);
    return res.status(status).json({ error: status === 500 ? 'failed to create rule' : err.message });
  }
}

/** GET /api/rules — caller's rules, most-recently-created first. */
async function listRules(req, res) {
  try {
    const rules = await Rule.find({ owner: req.userId })
      .sort({ createdAt: -1 })
      .populate('trigger.device', 'name type')
      .populate('conditions.device', 'name type')
      .populate('actions.device', 'name type');
    return res.json({ rules });
  } catch (err) {
    console.error('[rules] list error:', err.message);
    return res.status(500).json({ error: 'failed to list rules' });
  }
}

/**
 * PATCH /api/rules/:id
 * Minimal — just the enabled toggle for now, so a rule can be switched off
 * without resending the whole trigger/conditions/actions payload. Full
 * editing can wait for an actual rule-builder screen.
 */
async function toggleRule(req, res) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const rule = await Rule.findOneAndUpdate(
      { _id: req.params.id, owner: req.userId },
      { enabled },
      { new: true }
    );
    if (!rule) return res.status(404).json({ error: 'rule not found' });

    await rule.populate([
      { path: 'trigger.device', select: 'name type' },
      { path: 'conditions.device', select: 'name type' },
      { path: 'actions.device', select: 'name type' },
    ]);

    const response = { rule };
    if (rule.enabled) {
      const conflicts = await findConflictingRules(rule, req.userId, rule._id);
      if (conflicts.length) {
        response.warnings = conflicts.map(
          (c) => `Conflicts with rule "${c.ruleName}" (${c.ruleId}): ${c.reason}`
        );
      }
    }

    return res.json(response);
  } catch (err) {
    console.error('[rules] toggle error:', err.message);
    return res.status(500).json({ error: 'failed to update rule' });
  }
}

async function deleteRule(req, res) {
  try {
    const rule = await Rule.findOneAndDelete({ _id: req.params.id, owner: req.userId });
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    return res.json({ status: 'deleted' });
  } catch (err) {
    console.error('[rules] delete error:', err.message);
    return res.status(500).json({ error: 'failed to delete rule' });
  }
}

module.exports = { createRule, listRules, toggleRule, deleteRule };