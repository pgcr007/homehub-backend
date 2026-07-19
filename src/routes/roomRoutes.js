const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireHousehold = require('../middleware/requireHousehold');
const { createRoom, listRooms, updateRoom, deleteRoom } = require('../controllers/roomController');

const router = express.Router();

router.use(requireAuth);
router.use(requireHousehold);

router.post('/', createRoom);
router.get('/', listRooms);
router.patch('/:id', updateRoom);
router.delete('/:id', deleteRoom);

module.exports = router;