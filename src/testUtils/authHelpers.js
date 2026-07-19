const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Household = require('../models/Household');

function tokenFor(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET);
}

/**
 * Phase 6 test helper: every household-scoped route now needs both a valid
 * JWT (Authorization header) AND an X-Household-Id header pointing at a
 * household the token's user is actually a member of. This creates a real
 * Household doc (via the model directly, not the HTTP endpoint — keeps
 * tests fast and focused on the thing they're actually testing) with a
 * fresh user as its 'owner', and returns everything a test needs in one call.
 */
async function createAuthedHousehold(name = 'Test Household') {
  const userId = new mongoose.Types.ObjectId().toString();
  const household = await Household.create({
    name,
    members: [{ user: userId, role: 'owner' }],
  });
  const householdId = household._id.toString();
  const token = tokenFor(userId);

  return {
    userId,
    householdId,
    household,
    token,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Household-Id': householdId,
    },
  };
}

module.exports = { tokenFor, createAuthedHousehold };