const EventLog = require('../models/EventLog');

/** GET /api/events?limit=50 */
async function listEvents(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const events = await EventLog.find({ owner: req.userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('device', 'name type room');
  return res.json({ events });
}

module.exports = { listEvents };