const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const { createRule, listRules, toggleRule, deleteRule } = require('../controllers/ruleController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);

router.post('/', createRule);
router.get('/', listRules);
router.patch('/:id', toggleRule);
router.delete('/:id', deleteRule);

module.exports = router;