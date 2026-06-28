const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  scrapeCount: { type: Number, default: 0 },
  lastScrapeDate: { type: String, default: '' },
  subscribed: { type: Boolean, default: false },
  onHold: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
