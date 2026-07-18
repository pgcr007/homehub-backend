const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const { requireRole } = require('../middleware/requireHousehold');
const {
  createHousehold,
  listMyHouseholds,
  getHousehold,
  addMember,
  removeMember,
  deleteHousehold,
} = require('../controllers/householdController');

const router = express.Router();

router.use(requireAuth);

// These two don't need an X-Household-Id header — you don't know which
// household to scope to until you've either created one or listed the ones
// you're already in.
router.post('/', createHousehold);
router.get('/', listMyHouseholds);

// Everything below acts on a specific household, resolved + membership-
// checked via the X-Household-Id header rather than a :id route param, so
// it's consistent with how Rooms/Devices/Events/Rules will be scoped in
// Step 2.
router.get('/current', requireHousehold, getHousehold);
router.post('/current/members', requireHousehold, requireRole('owner', 'manager'), addMember);
router.delete(
  '/current/members/:userId',
  requireHousehold,
  requireRole('owner', 'manager'),
  removeMember
);
router.delete('/current', requireHousehold, requireRole('owner'), deleteHousehold);

module.exports = router;