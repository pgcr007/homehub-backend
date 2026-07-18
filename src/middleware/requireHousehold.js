const Household = require('../models/Household');

// Must run after requireAuth (needs req.userId). Every household-scoped
// route (rooms, devices, events, rules) sends an X-Household-Id header —
// the Android app remembers the user's active household and attaches it to
// every request, the same way it attaches the Bearer token. This is what
// replaces the old `{ owner: req.userId }` query scoping: it becomes
// `{ household: req.householdId }`, and access to that household is
// verified once, here, instead of re-derived per-controller.
//
// requireRole(...) is a factory for routes that need manager+ (e.g. invite
// member, remove member, delete household) — use as a second middleware
// after requireHousehold.
async function requireHousehold(req, res, next) {
  const householdId = req.headers['x-household-id'];

  if (!householdId) {
    return res.status(400).json({ error: 'X-Household-Id header is required' });
  }

  try {
    const household = await Household.findById(householdId);
    if (!household) {
      return res.status(404).json({ error: 'household not found' });
    }

    const role = household.roleOf(req.userId);
    if (!role) {
      // Deliberately 404, not 403 — don't confirm the household exists to a
      // non-member probing IDs.
      return res.status(404).json({ error: 'household not found' });
    }

    req.household = household;
    req.householdId = household._id.toString();
    req.householdRole = role;
    next();
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(400).json({ error: 'invalid household id' });
    }
    console.error('[requireHousehold] error:', err.message);
    return res.status(500).json({ error: 'failed to resolve household' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.householdRole) {
      // Programmer error: requireRole used without requireHousehold first.
      return res.status(500).json({ error: 'household context missing' });
    }
    if (!allowedRoles.includes(req.householdRole)) {
      return res.status(403).json({ error: 'insufficient household role' });
    }
    next();
  };
}

module.exports = requireHousehold;
module.exports.requireRole = requireRole;