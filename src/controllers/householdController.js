const Household = require('../models/Household');
const User = require('../models/User');

// Creates a new household with the caller as its 'owner'. A residential
// user calls this once, ever. A property manager calls this once per unit
// they onboard.
async function createHousehold(req, res) {
  const { name, type } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (type && !['residential', 'unit'].includes(type)) {
    return res.status(400).json({ error: 'type must be residential or unit' });
  }

  try {
    const household = await Household.create({
      name: name.trim(),
      type: type || 'residential',
      members: [{ user: req.userId, role: 'owner' }],
    });

    // Convenience pointer so the app can pre-select an active household
    // right after signup without an extra round trip. Not used for
    // authorization anywhere — that's always Household.members.
    await User.findByIdAndUpdate(req.userId, { household: household._id });

    return res.status(201).json({ household });
  } catch (err) {
    console.error('[households] create error:', err.message);
    return res.status(500).json({ error: 'failed to create household' });
  }
}

// Every household the caller belongs to, across every role — this is the
// "unit switcher" list for a property manager as well as the single-item
// list for a residential user.
async function listMyHouseholds(req, res) {
  const households = await Household.find({ 'members.user': req.userId }).sort({ name: 1 });

  const withMyRole = households.map((h) => ({
    ...h.toObject(),
    myRole: h.roleOf(req.userId),
  }));

  return res.json({ households: withMyRole });
}

async function getHousehold(req, res) {
  // req.household already loaded + membership-verified by requireHousehold
  const household = await req.household.populate('members.user', 'email name');
  return res.json({ household, myRole: req.householdRole });
}

// manager+ only (enforced by requireRole in the route). Adds an existing
// user (by email) as a member. Phase 6 keeps this simple — no invite-email
// flow yet, the person being added must already have a HomeHub account.
// manager+ only (enforced by requireRole in the route). Adds an existing
// user (by email) as a member. Phase 6 keeps this simple — no invite-email
// flow yet, the person being added must already have a HomeHub account.
// 'guest' additionally requires expiresAt — that's the entire point of the
// role, so it's not optional the way it is for owner/manager/member.
async function addMember(req, res) {
  const { email, role, expiresAt } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }
  const targetRole = role || 'member';
  if (!['owner', 'manager', 'member', 'guest'].includes(targetRole)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  // Only an owner can grant the owner role — a manager elevating someone to
  // owner (and thus household-deletion rights) would be a privilege escalation.
  if (targetRole === 'owner' && req.householdRole !== 'owner') {
    return res.status(403).json({ error: 'only an owner can add another owner' });
  }

  let parsedExpiresAt = null;
  if (targetRole === 'guest') {
    if (!expiresAt) {
      return res.status(400).json({ error: 'expiresAt is required for guest access' });
    }
    parsedExpiresAt = new Date(expiresAt);
    if (Number.isNaN(parsedExpiresAt.getTime())) {
      return res.status(400).json({ error: 'expiresAt must be a valid date' });
    }
    if (parsedExpiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'expiresAt must be in the future' });
    }
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ error: 'no user with that email' });
    }

    const household = req.household;

    // isMember() ignores expired guest entries, so re-inviting a guest whose
    // access lapsed falls through to here instead of hitting the 409 below —
    // but the stale subdocument has to be dropped first or the household
    // ends up with two entries for the same user.
    const existingIndex = household.members.findIndex(
      (m) => m.user.toString() === user._id.toString()
    );
    if (existingIndex !== -1) {
      if (household.isMember(user._id)) {
        return res.status(409).json({ error: 'user is already a member' });
      }
      household.members.splice(existingIndex, 1);
    }

    household.members.push({
      user: user._id,
      role: targetRole,
      expiresAt: parsedExpiresAt,
    });
    await household.save();

    const populated = await household.populate('members.user', 'email name');
    return res.status(201).json({ household: populated });
  } catch (err) {
    console.error('[households] addMember error:', err.message);
    return res.status(500).json({ error: 'failed to add member' });
  }
}

// manager+ only. A manager can remove members/other managers but not an
// owner (prevents a manager from locking the owner out of their own
// household). An owner can remove anyone, including stepping down only if
// another owner remains (enforced by the schema's "at least one owner"
// validator on save).
async function removeMember(req, res) {
  const { userId } = req.params;
  const household = req.household;

  const target = household.members.find((m) => m.user.toString() === userId);
  if (!target) {
    return res.status(404).json({ error: 'user is not a member of this household' });
  }
  if (target.role === 'owner' && req.householdRole !== 'owner') {
    return res.status(403).json({ error: 'only an owner can remove an owner' });
  }

  household.members = household.members.filter((m) => m.user.toString() !== userId);

  try {
    await household.save();
    return res.json({ status: 'removed' });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(409).json({ error: 'a household must have at least one owner' });
    }
    console.error('[households] removeMember error:', err.message);
    return res.status(500).json({ error: 'failed to remove member' });
  }
}

async function getBrokerInfo(req, res) {
  const household = req.household;
  const topicPrefix = `home/${household._id}`;

  return res.json({
    householdId: household._id.toString(),
    topicPrefix,
    topics: {
      state: `${topicPrefix}/{identifier}/state`,
      status: `${topicPrefix}/{identifier}/status`,
      normalized: `${topicPrefix}/{deviceId}/normalized`,
      cmd: `${topicPrefix}/{identifier}/cmd`,
    },
    mqttAcl: {
      configured: household.mqttAcl?.configured || false,
      brokerUsername: household.mqttAcl?.brokerUsername || null,
      configuredAt: household.mqttAcl?.configuredAt || null,
    },
    setupInstructions:
      'In the HiveMQ Cloud console, under Access Management, create a dedicated credential for ' +
      `this household, then add a Permission scoped to topic filter "${topicPrefix}/#" with ` +
      'Publish and Subscribe both checked. Give that credential — not the shared backend service ' +
      'credential — to whatever device or gateway is physically installed at this unit. Full runbook: ' +
      'docs/PHASE6_STEP3_BROKER_ACL.md.',
  });
}


async function confirmBrokerAcl(req, res) {
  const { brokerUsername } = req.body;
  if (!brokerUsername || !brokerUsername.trim()) {
    return res.status(400).json({ error: 'brokerUsername is required' });
  }

  req.household.mqttAcl = {
    configured: true,
    brokerUsername: brokerUsername.trim(),
    configuredAt: new Date(),
  };

  try {
    await req.household.save();
    return res.json({ mqttAcl: req.household.mqttAcl });
  } catch (err) {
    console.error('[households] confirmBrokerAcl error:', err.message);
    return res.status(500).json({ error: 'failed to save broker ACL confirmation' });
  }
}


// owner only.
async function deleteHousehold(req, res) {
  if (req.householdRole !== 'owner') {
    return res.status(403).json({ error: 'only an owner can delete a household' });
  }
  // Phase 6 deliberately does NOT cascade-delete Rooms/Devices/EventLogs/Rules
  // here — that's a destructive, hard-to-undo action tied to real device data.
  // Leaving it as a manual/admin cleanup step for now; revisit if this
  // becomes a real user-facing "delete my account" flow.
  await req.household.deleteOne();
  return res.json({ status: 'deleted' });
}

module.exports = {
  createHousehold,
  listMyHouseholds,
  getHousehold,
  addMember,
  removeMember,
  deleteHousehold,
  getBrokerInfo,
  confirmBrokerAcl,
};