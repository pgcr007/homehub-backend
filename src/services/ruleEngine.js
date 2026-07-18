const crypto = require('crypto');
const Device = require('../models/Device');
const Rule = require('../models/Rule');
const EventLog = require('../models/EventLog');
const { publishCommand } = require('./mqttService');
const { sendToUser } = require('./fcmService');

/**
 * Phase 5: evaluates enabled rules against incoming device state changes and
 * fires their actions.
 *
 * The hard part isn't matching triggers — it's loop protection. A rule's
 * `device_command` action publishes to MQTT and returns immediately; nothing
 * calls this engine again as part of that same function call. If the
 * targeted device later reports back a new state (a real device echoing the
 * command it just received), that arrives as a *completely separate*
 * invocation of handleStateTopic/handleWebhookEvent, seconds later, with no
 * call-stack connection to the rule that caused it. So chain depth can't be
 * threaded through as a normal argument — it has to be correlated
 * out-of-band by device ID across that async gap. That's what
 * pendingChains does: mark right before publishing, consume when the next
 * event for that device arrives.
 *
 * This is a best-effort heuristic (correlates by deviceId + a time window),
 * not a guarantee — if two independent actions target the same device
 * within the TTL, the correlation could attribute the wrong chain. Fine for
 * this project's scale (one command in flight per device is the norm); a
 * production system fielding lots of concurrent commands per device would
 * want a real per-command correlation ID round-tripped through the device
 * firmware instead.
 */
const PENDING_CHAIN_TTL_MS = 30_000;
const pendingChains = new Map();

function markPendingChain(deviceId, chainId, chainDepth) {
  pendingChains.set(String(deviceId), {
    chainId,
    chainDepth,
    expiresAt: Date.now() + PENDING_CHAIN_TTL_MS,
  });
}

/** Looks up and clears any pending chain context for a device, returning depth 0 if none/expired. */
function consumePendingChain(deviceId) {
  const key = String(deviceId);
  const entry = pendingChains.get(key);
  if (!entry) return { chainId: null, chainDepth: 0 };
  pendingChains.delete(key);
  if (entry.expiresAt < Date.now()) return { chainId: null, chainDepth: 0 };
  return { chainId: entry.chainId, chainDepth: entry.chainDepth };
}

function evaluateOperator(operator, newValue, oldValue, target) {
  switch (operator) {
    case 'changed':
      return oldValue !== newValue;
    case 'eq':
      return newValue === target;
    case 'neq':
      return newValue !== target;
    case 'gt':
      return Number(newValue) > Number(target);
    case 'lt':
      return Number(newValue) < Number(target);
    case 'gte':
      return Number(newValue) >= Number(target);
    case 'lte':
      return Number(newValue) <= Number(target);
    default:
      return false;
  }
}

/**
 * Conditions gate whether a matched trigger's actions fire, checked against
 * each referenced device's *current* stored state (not a delta) — there's
 * no natural "before" value at condition-check time, so 'changed' has no
 * coherent meaning here and fails safe rather than guessing.
 */
async function checkConditions(conditions) {
  for (const cond of conditions) {
    if (cond.operator === 'changed') {
      console.warn(`[rules] condition on device ${cond.device} uses 'changed', which isn't meaningful for a condition — treating as not met`);
      return false;
    }
    const condDevice = await Device.findById(cond.device);
    if (!condDevice) return false;
    const currentValue = condDevice.state?.[cond.capability];
    if (!evaluateOperator(cond.operator, currentValue, undefined, cond.value)) {
      return false;
    }
  }
  return true;
}

async function executeActions(rule, chainId, chainDepth) {
  for (const action of rule.actions) {
    if (action.type === 'device_command') {
      const actionDevice = await Device.findById(action.device);
      if (!actionDevice) {
        console.warn(`[rules] rule ${rule._id} action references missing device ${action.device}`);
        continue;
      }
      if (actionDevice.protocol !== 'mqtt') {
        console.warn(`[rules] rule ${rule._id} action targets non-MQTT device ${actionDevice._id}, skipping`);
        continue;
      }
      // Mark before publishing, not after — the device could echo back
      // faster than we'd like to assume.
      markPendingChain(actionDevice._id, chainId, chainDepth + 1);
      try {
        publishCommand(actionDevice, { [action.capability]: action.value });
      } catch (err) {
        console.warn(`[rules] rule ${rule._id} failed to publish command: ${err.message}`);
      }
    } else if (action.type === 'notify') {
      try {
        await sendToUser(rule.owner, {
          title: 'HomeHub',
          body: action.message || `Rule "${rule.name}" fired`,
        });
      } catch (err) {
        console.warn(`[rules] rule ${rule._id} notify action failed: ${err.message}`);
      }
    }
  }
}

/**
 * Called after a device's state has been persisted (from handleStateTopic
 * or handleWebhookEvent) with the normalized delta from *this* event only —
 * a rule only evaluates if its trigger's capability is actually part of
 * that delta, so a rule doesn't refire just because an unrelated capability
 * on the same device reported in.
 *
 * @param {object} params
 * @param {object} params.device - the Device doc (state already updated/saved)
 * @param {object} params.normalizedState - this event's normalized delta
 * @param {object} params.previousState - device.state before this event's merge
 * @param {string|null} params.chainId - carried from consumePendingChain, or null if organic
 * @param {number} params.chainDepth - carried from consumePendingChain, 0 if organic
 */
async function evaluateRulesForEvent({ device, normalizedState, previousState, chainId = null, chainDepth = 0 }) {
  const rules = await Rule.find({
    owner: device.owner,
    enabled: true,
    'trigger.device': device._id,
  });

  for (const rule of rules) {
    const capability = rule.trigger.capability;
    if (!(capability in normalizedState)) continue; // this event didn't touch the trigger's capability

    const newValue = normalizedState[capability];
    const oldValue = previousState?.[capability];
    if (!evaluateOperator(rule.trigger.operator, newValue, oldValue, rule.trigger.value)) continue;

    if (chainDepth > 0 && chainDepth >= rule.maxChainDepth) {
      await EventLog.create({
        device: device._id,
        owner: device.owner,
        source: 'rule',
        type: 'rule_blocked',
        normalizedState: { ruleId: rule._id, ruleName: rule.name, reason: 'max_chain_depth_exceeded' },
        chainId,
        chainDepth,
      });
      continue;
    }

    const conditionsMet = await checkConditions(rule.conditions);
    if (!conditionsMet) continue;

    // First hop in a fresh cascade gets a new chainId; later hops carry
    // forward the one they arrived with.
    const thisChainId = chainId || crypto.randomUUID();

    await EventLog.create({
      device: device._id,
      owner: device.owner,
      source: 'rule',
      type: 'rule_fired',
      normalizedState: { ruleId: rule._id, ruleName: rule.name, actionsCount: rule.actions.length },
      chainId: thisChainId,
      chainDepth,
    });

    await executeActions(rule, thisChainId, chainDepth);
  }
}

/**
 * Two rules are flagged as a *potential* conflict if:
 *   1. They react to the same trigger device+capability (so the same
 *      real-world state change could cause both to evaluate), and
 *   2. At least one of their device_command actions targets the same
 *      device+capability with a *different* value.
 *
 * #1 is deliberately broad rather than comparing operators exactly —
 * different operators on the same capability can still both match a given
 * incoming value (e.g. 'changed' matches any change, 'eq' matches one
 * specific value that a 'changed' rule could just as easily have matched
 * too). This is surfaced as a warning, not a block: only the person creating
 * the rule knows whether two rules reacting to the same trigger with
 * opposing actions is a mistake or intentional (e.g. rules gated by
 * different, mutually-exclusive conditions).
 */
async function findConflictingRules(candidateRule, ownerId, excludeRuleId = null) {
  const query = {
    owner: ownerId,
    enabled: true,
    'trigger.device': candidateRule.trigger.device,
    'trigger.capability': candidateRule.trigger.capability,
  };
  if (excludeRuleId) query._id = { $ne: excludeRuleId };

  const sameTrigger = await Rule.find(query);
  const conflicts = [];

  for (const other of sameTrigger) {
    for (const a of candidateRule.actions) {
      if (a.type !== 'device_command') continue;
      for (const b of other.actions) {
        if (b.type !== 'device_command') continue;
        if (String(a.device) === String(b.device) && a.capability === b.capability && a.value !== b.value) {
          conflicts.push({
            ruleId: other._id,
            ruleName: other.name,
            reason: `both react to the same trigger and set "${a.capability}" on the same device to different values ("${a.value}" vs "${b.value}")`,
          });
        }
      }
    }
  }

  return conflicts;
}

module.exports = { evaluateRulesForEvent, consumePendingChain, findConflictingRules };