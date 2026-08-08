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
    // 'guest' is a time-boxed variant of 'member' — same dashboard access,
    // but requires expiresAt and is treated as a non-member automatically
    // once that time passes (see roleOf/isMember below). No separate expiry
    // job: it's checked lazily on read, same "derive on read" approach used
    // for usage insights.
    role: { type: String, enum: ['owner', 'manager', 'member', 'guest'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
    // Required for 'guest' (enforced in householdController.addMember, not
    // here, so the error message can be role-specific). Ignored for every
    // other role.
    expiresAt: { type: Date, default: null },
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
    mqttAcl: {
      configured: { type: Boolean, default: false },
      brokerUsername: { type: String, trim: true, default: null },
      configuredAt: { type: Date, default: null },
    },
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
  if (!member) return null;
  if (member.role === 'guest' && member.expiresAt && member.expiresAt.getTime() <= Date.now()) {
    // Expired guest access. Treated identically to "never a member" rather
    // than deleting the subdocument here, so the expiry timestamp is
    // preserved for the members list / audit trail instead of silently
    // vanishing. A manager can still see it (grayed out) and remove it.
    return null;
  }
  return member.role;
};

householdSchema.methods.isMember = function (userId) {
  return this.roleOf(userId) !== null;
};

module.exports = mongoose.model('Household', householdSchema);