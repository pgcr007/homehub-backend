const { computeUsage } = require('../services/usageService');

/** GET /api/insights/usage?days=7 */
async function getUsage(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
    const usage = await computeUsage(req.householdId, days);
    return res.json(usage);
  } catch (err) {
    console.error('[insightsController] getUsage error:', err.message);
    return res.status(500).json({ error: 'failed to compute usage insights' });
  }
}

module.exports = { getUsage };