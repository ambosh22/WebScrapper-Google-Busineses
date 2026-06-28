require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // ============================================================
  // Idagdag mo dito ang bagong user accounts.
  // Format: { username: '...', password: '...' }
  // Pwede mag-add ng kasing dami mo gusto, basta comma-separated.
  // ============================================================
  const users = [
    { username: 'admin', password: 'admin@123' },

    // 👇 Halimbawa ng bagong accounts — palitan mo ng totoong
    //    username/password, o burahin kung hindi kailangan.
    { username: 'newuser1', password: 'ChangeThisPassword1' },
    { username: 'newuser2', password: 'ChangeThisPassword2' },
  ];

  for (const u of users) {
    const role = u.role || (u.username === 'admin' ? 'admin' : 'user');
    const existing = await User.findOne({ username: u.username });
    if (existing) {
      if (existing.role !== role) {
        existing.role = role;
        await existing.save();
        console.log(`User "${u.username}" updated to role "${role}"`);
      } else {
        console.log(`User "${u.username}" already exists (${role})`);
      }
      continue;
    }
    const hashed = await bcrypt.hash(u.password, 10);
    await User.create({ username: u.username, password: hashed, role });
    console.log(`User "${u.username}" created (${role})`);
  }

  await mongoose.disconnect();
  console.log('Done');
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});