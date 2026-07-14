const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      trim: true,
    },
    // Phase 6 will extend this with household/unit membership for B2B mode
    household: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Household',
      default: null,
    },
    notificationPreferences: {
      ruleFired: { type: Boolean, default: true },
      deviceOffline: { type: Boolean, default: true },
    },
    fcmTokens: [{ type: String }],
  },
  { timestamps: true }
);

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 10);
};

// Never leak the hash if a User doc is ever serialized directly
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);