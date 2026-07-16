const mongoose = require('mongoose');

// A single condition/trigger clause: "device X's capability Y meets operator Z
// against value V". Triggers and conditions share this shape; a trigger is
// just the clause that starts evaluation, conditions gate whether actions fire.
const clauseSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    capability: { type: String, required: true }, // e.g. 'power', 'motion', 'temperature'
    operator: {
      type: String,
      enum: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'changed'],
      required: true,
    },
    value: { type: mongoose.Schema.Types.Mixed }, // not required for 'changed'
  },
  { _id: false }
);

const actionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['device_command', 'notify'], required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device' }, // required if type === 'device_command'
    capability: { type: String }, // e.g. 'power'
    value: { type: mongoose.Schema.Types.Mixed }, // e.g. 'off'
    message: { type: String }, // required if type === 'notify'
  },
  { _id: false }
);

const ruleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enabled: { type: Boolean, default: true },
    trigger: { type: clauseSchema, required: true },
    // ANDed together — Phase 5 decides if OR groups are ever needed.
    conditions: { type: [clauseSchema], default: [] },
    actions: { type: [actionSchema], default: [] },
    // Phase 5 loop-protection field, reserved now so the schema doesn't need
    // a migration later: how many rule-triggered hops deep this rule is
    // allowed to fire from within, when triggered by another rule's action.
    maxChainDepth: { type: Number, default: 3 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Rule', ruleSchema);