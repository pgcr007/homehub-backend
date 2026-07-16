const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const { createRoom, listRooms, updateRoom, deleteRoom } = require('../controllers/roomController');

const router = express.Router();

router.use(requireAuth);

router.post('/', createRoom);
router.get('/', listRooms);
router.patch('/:id', updateRoom);
router.delete('/:id', deleteRoom);

module.exports = router;