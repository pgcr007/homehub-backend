const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Phase 6: scoped to a household (multi-member, role-aware) instead of a
    // single owner user. Access control now flows through Household.members
    // via requireHousehold, not through this field directly.
    household: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Household',
      required: true,
    },
  },
  { timestamps: true }
);

roomSchema.index({ household: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Room', roomSchema);