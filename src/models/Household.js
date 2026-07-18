const mongoose = require('mongoose');

// A Household is the Phase 6 tenancy boundary. For a solo/residential user
// it's just "my home" with one member. For the B2B case (property manager /
// Airbnb host) each managed property is its own Household document, and the
// manager is a member of every one of them — so "which units does this user
// manage" is just `Household.find({ 'members.user': managerId })`, no
// separate join table needed.
const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // 'owner' created the household and can delete it / manage all members.
    // 'manager' can invite/remove members and manage devices+rules but can't
    // delete the household itself. 'member' has normal dashboard access
    // (view/control devices, view rules) but can't manage membership.
    role: { type: String, enum: ['owner', 'manager', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const householdSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // 'residential' = a single home, one household total for that user.
    // 'unit' = one property-manager-owned rental/office unit; a manager
    // typically has many of these.
    type: { type: String, enum: ['residential', 'unit'], default: 'residential' },
    members: {
      type: [memberSchema],
      default: [],
      validate: {
        validator: (arr) => arr.some((m) => m.role === 'owner'),
        message: 'a household must have at least one owner',
      },
    },
  },
  { timestamps: true }
);

householdSchema.index({ 'members.user': 1 });

householdSchema.methods.roleOf = function (userId) {
  const member = this.members.find((m) => m.user.toString() === userId.toString());
  return member ? member.role : null;
};

householdSchema.methods.isMember = function (userId) {
  return this.roleOf(userId) !== null;
};

module.exports = mongoose.model('Household', householdSchema);