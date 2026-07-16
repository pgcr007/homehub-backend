const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Scoped to a single user for now. Phase 6 will add a `household` ref
    // alongside/instead of this, once multi-unit mode exists — see the
    // open design question carried over from Phase 1.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

roomSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Room', roomSchema);