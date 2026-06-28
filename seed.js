require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const users = [
    { username: 'admin', password: 'admin123' },
    { username: 'user1', password: 'user1234' },
    { username: 'user2', password: 'user1234' },
  ];

  for (const u of users) {
    const role = u.role || (u.username === 'admin' ? 'admin' : 'user');
    const existing = await User.findOne({ username: u.username });
    if (existing) {
      if (existing.role !== role) {
        existing.role = role;
        existing.password = await bcrypt.hash(u.password, 10);
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