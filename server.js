try { require('dotenv').config(); } catch {} // optional — platform env vars work too
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const { runScraper } = require('./scraper');
const { execSync } = require('child_process');

const PW_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
let PW_BROWSERS_READY = false;

if (fs.existsSync(path.join(PW_BROWSERS_PATH, 'chromium_headless_shell-1228'))) {
  PW_BROWSERS_READY = true;
} else {
  console.log('Playwright browsers not found — installing asynchronously...');
  const proc = require('child_process').exec(
    `PLAYWRIGHT_BROWSERS_PATH=${PW_BROWSERS_PATH} node node_modules/playwright/cli.js install chromium-headless-shell`,
    { timeout: 180000 },
    (err) => {
      if (err) console.error('Playwright install failed:', err.message);
      else { console.log('Playwright browsers installed'); PW_BROWSERS_READY = true; }
    }
  );
  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);
}

const app = express();
app.set('trust proxy', 1);

// --- Security middleware ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.disable('x-powered-by');

// --- Rate limiting ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public', { maxAge: 0 }));

const PORT = process.env.PORT || 3000;

// --- MongoDB ---
async function autoSeedAdmin() {
  try {
    const count = await User.countDocuments();
    if (count === 0) {
      const hashed = await bcrypt.hash('admin123', 10);
      await User.create({ username: 'admin', password: hashed, role: 'admin' });
      console.log('Auto-seeded admin user (admin/admin123)');
    }
  } catch (err) {
    console.error('Auto-seed admin failed:', err.message);
  }
}

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    tlsAllowInvalidCertificates: true,
  })
    .then(() => {
      console.log('MongoDB connected');
      autoSeedAdmin();
    })
    .catch(err => console.error('MongoDB connection error:', err.message));
} else {
  console.log('MongoDB: no MONGODB_URI set — auth/rate-limit features disabled');
}

// --- Auth ---
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;
const tokens = {};

const FALLBACK_ADMIN = {
  _id: 'fallback-admin',
  username: 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123',
  role: 'admin',
  onHold: false
};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sanitize(str) {
  return typeof str === 'string' ? str.replace(/[<>]/g, '').trim() : '';
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of Object.entries(tokens)) {
    if (now > session.expiresAt) delete tokens[token];
  }
}, 60 * 60 * 1000);

app.post('/api/login', loginLimiter, async (req, res) => {
  const username = sanitize(req.body.username);
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    let user;
    if (process.env.MONGODB_URI) {
      user = await User.findOne({ username });
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Invalid username or password' });
      if (user.username === 'admin' && user.role !== 'admin') {
        user.role = 'admin';
        await user.save();
      }
      if (user.onHold && user.role !== 'admin') {
        console.log(`[LOGIN] Blocked held user: ${username}, onHold=${user.onHold}, role=${user.role}`);
        return res.json({ onHold: true, role: user.role });
      }
      console.log(`[LOGIN] Allowed user: ${username}, onHold=${user.onHold}, role=${user.role}`);
    } else {
      if (username !== FALLBACK_ADMIN.username || password !== FALLBACK_ADMIN.password) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      user = FALLBACK_ADMIN;
    }
    const role = user.role || 'user';
    const token = generateToken();
    tokens[token] = { userId: user._id.toString(), username: user.username, role, expiresAt: Date.now() + TOKEN_EXPIRY_MS };
    res.json({ token, role });
  } catch (err) {
    console.error('[LOGIN] Error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

function getSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const session = tokens[auth.slice(7)];
  if (!session || Date.now() > session.expiresAt) {
    if (session) delete tokens[auth.slice(7)];
    return null;
  }
  return session;
}

app.get('/api/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  if (!process.env.MONGODB_URI) {
    return res.json({ username: session.username, role: session.role, onHold: false });
  }
  try {
    const user = await User.findById(session.userId);
    const onHold = user ? user.onHold : false;
    res.json({ username: session.username, role: session.role, onHold });
  } catch {
    res.json({ username: session.username, role: session.role, onHold: false });
  }
});

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = session.userId;
  req.username = session.username;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.userId = session.userId;
  req.username = session.username;
  req.role = session.role;
  next();
}

// --- Admin endpoints ---
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.json({ totalUsers: 0, adminUsers: 1, regularUsers: 0, activeToday: 0, totalScrapesToday: 0 });
  try {
    const totalUsers = await User.countDocuments();
    const adminUsers = await User.countDocuments({ role: 'admin' });
    const regularUsers = await User.countDocuments({ role: 'user' });
    const today = new Date().toISOString().split('T')[0];
    const activeToday = await User.countDocuments({ lastScrapeDate: today });
    const totalScrapesToday = await User.aggregate([
      { $match: { lastScrapeDate: today } },
      { $group: { _id: null, total: { $sum: '$scrapeCount' } } }
    ]);
    res.json({
      totalUsers,
      adminUsers,
      regularUsers,
      activeToday,
      totalScrapesToday: totalScrapesToday.length > 0 ? totalScrapesToday[0].total : 0
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.json([]);
  try {
    const users = await User.find({}, { password: 0 }).sort({ createdAt: -1 });
    users.forEach(u => console.log(`[USERS] ${u.username}: onHold=${u.onHold}, role=${u.role}`));
    res.json(users);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB required to create users' });
  const username = sanitize(req.body.username);
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  try {
    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashed, role: 'user' });
    res.json({ _id: user._id, username: user.username, role: user.role, createdAt: user.createdAt });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB required to edit users' });
  const username = sanitize(req.body.username);
  const password = req.body.password || '';
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin' && username !== user.username) return res.status(403).json({ error: 'Cannot rename admin users' });
    const existing = await User.findOne({ username, _id: { $ne: req.params.id } });
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    user.username = username;
    if (password) {
      if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      user.password = await bcrypt.hash(password, 10);
    }
    await user.save();
    res.json({ _id: user._id, username: user.username, role: user.role });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB required to delete users' });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Cannot delete admin users' });
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/users/:id/subscribe', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB required' });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.subscribed = !user.subscribed;
    await user.save();
    res.json({ _id: user._id, username: user.username, subscribed: user.subscribed });
  } catch { res.status(500).json({ error: 'Server error' }); }
});



// --- Scrape limit middleware ---
async function checkScrapeLimit(req, res, next) {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB not configured — scraping requires a database' });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.onHold) return res.status(403).json({ error: 'Account on hold — contact admin' });
    if (user.role === 'admin') return next();
    const today = new Date().toISOString().split('T')[0];
    if (user.lastScrapeDate !== today) {
      user.scrapeCount = 0;
      user.lastScrapeDate = today;
      await user.save();
    }
    if (user.scrapeCount >= 2) return res.status(429).json({ error: 'Daily limit reached — 2 scrapes per day only' });
    next();
  } catch { res.status(500).json({ error: 'Server error' }); }
}
const JOBS_DIR = path.join(os.tmpdir(), 'web2-jobs');
if (!fs.existsSync(JOBS_DIR)) try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch {}

const CITIES = {
  "Alabama": ["Birmingham","Montgomery","Mobile","Huntsville","Tuscaloosa","Hoover","Auburn","Dothan","Madison","Decatur","Florence","Gadsden","Vestavia Hills","Prattville","Phenix City"],
  "Alaska": ["Anchorage","Fairbanks","Juneau","Wasilla","Kenai","Palmer","Homer","Sitka","Ketchikan","Bethel","Soldotna","Unalaska","Valdez","Cordova","North Pole"],
  "Arizona": ["Phoenix","Tucson","Mesa","Chandler","Gilbert","Glendale","Scottsdale","Peoria","Tempe","Surprise","Flagstaff","Prescott","Yuma","Avondale","Goodyear"],
  "Arkansas": ["Little Rock","Fayetteville","Fort Smith","Springdale","Jonesboro","Rogers","Conway","North Little Rock","Bentonville","Pine Bluff","Hot Springs","Benton","Texarkana","Sherwood","Jacksonville"],
  "California": ["Los Angeles","San Diego","San Jose","San Francisco","Fresno","Sacramento","Long Beach","Oakland","Bakersfield","Anaheim","Riverside","Santa Ana","Irvine","Stockton","San Bernardino"],
  "Colorado": ["Denver","Colorado Springs","Aurora","Fort Collins","Lakewood","Boulder","Greeley","Longmont","Loveland","Grand Junction","Pueblo","Arvada","Westminster","Thornton","Centennial"],
  "Connecticut": ["Bridgeport","New Haven","Hartford","Stamford","Waterbury","Norwalk","Danbury","New Britain","Bristol","Meriden","Milford","Middletown","West Hartford","Groton","Torrington"],
  "Delaware": ["Wilmington","Dover","Newark","Middletown","Smyrna","Milford","Seaford","Georgetown","Elsmere","New Castle","Laurel","Harrington","Lewes","Rehoboth Beach","Clayton"],
  "Florida": ["Jacksonville","Miami","Tampa","Orlando","St. Petersburg","Hialeah","Fort Lauderdale","Tallahassee","Cape Coral","Port St. Lucie","Pembroke Pines","Hollywood","Gainesville","Miramar","Coral Springs"],
  "Georgia": ["Atlanta","Augusta","Columbus","Savannah","Athens","Sandy Springs","Macon","Roswell","Albany","Johns Creek","Warner Robins","Valdosta","Alpharetta","Marietta","Smyrna"],
  "Hawaii": ["Honolulu","Hilo","Kailua","Kapolei","Kahului","Kihei","Lihue","Pearl City","Waipahu","Mililani","Ewa Beach","Kaneohe","Wailuku","Lahaina","Schofield Barracks"],
  "Idaho": ["Boise","Meridian","Nampa","Idaho Falls","Caldwell","Pocatello","Coeur d'Alene","Twin Falls","Lewiston","Post Falls","Moscow","Rexburg","Eagle","Kuna","Ammon"],
  "Illinois": ["Chicago","Aurora","Rockford","Joliet","Naperville","Springfield","Peoria","Elgin","Waukegan","Champaign","Bloomington","Decatur","Evanston","Schaumburg","Arlington Heights"],
  "Indiana": ["Indianapolis","Fort Wayne","Evansville","South Bend","Carmel","Bloomington","Fishers","Hammond","Gary","Lafayette","Muncie","Terre Haute","Kokomo","Anderson","Elkhart"],
  "Iowa": ["Des Moines","Cedar Rapids","Davenport","Sioux City","Iowa City","Waterloo","Council Bluffs","Ames","West Des Moines","Dubuque","Ankeny","Urbandale","Cedar Falls","Marion","Bettendorf"],
  "Kansas": ["Wichita","Overland Park","Kansas City","Olathe","Topeka","Lawrence","Shawnee","Manhattan","Lenexa","Salina","Hutchinson","Leavenworth","Leawood","Dodge City","Garden City"],
  "Kentucky": ["Louisville","Lexington","Bowling Green","Owensboro","Covington","Richmond","Georgetown","Florence","Hopkinsville","Nicholasville","Frankfort","Henderson","Paducah","Jeffersontown","Ashland"],
  "Louisiana": ["New Orleans","Baton Rouge","Shreveport","Lafayette","Lake Charles","Kenner","Bossier City","Monroe","Alexandria","Houma","Slidell","Gretna","New Iberia","Ruston","Hammond"],
  "Maine": ["Portland","Lewiston","Bangor","South Portland","Auburn","Biddeford","Augusta","Waterville","Saco","Westbrook","Brewer","Brunswick","Old Town","Caribou","Ellsworth"],
  "Maryland": ["Baltimore","Frederick","Rockville","Gaithersburg","Bowie","Hagerstown","Annapolis","College Park","Salisbury","Laurel","Greenbelt","Cumberland","Westminster","Elkton","Aberdeen"],
  "Massachusetts": ["Boston","Worcester","Springfield","Cambridge","Lowell","Brockton","New Bedford","Fall River","Lynn","Quincy","Newton","Lawrence","Somerville","Framingham","Haverhill"],
  "Michigan": ["Detroit","Grand Rapids","Warren","Sterling Heights","Ann Arbor","Lansing","Flint","Dearborn","Livonia","Troy","Farmington Hills","Kalamazoo","Wyoming","Southfield","Rochester Hills"],
  "Minnesota": ["Minneapolis","Saint Paul","Rochester","Duluth","Bloomington","Brooklyn Park","Plymouth","Woodbury","Lakeville","St. Cloud","Maple Grove","Eagan","Burnsville","Eden Prairie","Coon Rapids"],
  "Mississippi": ["Jackson","Gulfport","Southaven","Hattiesburg","Biloxi","Olive Branch","Tupelo","Meridian","Greenville","Clinton","Madison","Pearl","Oxford","Horn Lake","Starkville"],
  "Missouri": ["Kansas City","St. Louis","Springfield","Columbia","Independence","Lee's Summit","O'Fallon","St. Charles","Blue Springs","St. Joseph","Joplin","Florissant","Cape Girardeau","Wentzville","Wildwood"],
  "Montana": ["Billings","Missoula","Great Falls","Bozeman","Butte","Helena","Kalispell","Havre","Anaconda","Miles City","Belgrade","Livingston","Whitefish","Lewistown","Sidney"],
  "Nebraska": ["Omaha","Lincoln","Bellevue","Grand Island","Kearney","Fremont","Norfolk","North Platte","Hastings","Columbus","Papillion","La Vista","Scottsbluff","South Sioux City","Beatrice"],
  "Nevada": ["Las Vegas","Henderson","Reno","North Las Vegas","Sparks","Carson City","Elko","Mesquite","Boulder City","Fallon","Winnemucca","Fernley","Pahrump","Dayton","Lovelock"],
  "New Hampshire": ["Manchester","Nashua","Concord","Derry","Dover","Rochester","Salem","Keene","Berlin","Laconia","Claremont","Lebanon","Portsmouth","Franklin","Somersworth"],
  "New Jersey": ["Newark","Jersey City","Paterson","Elizabeth","Edison","Trenton","Woodbridge","Camden","Clifton","Passaic","Union City","East Orange","Bayonne","Vineland","Hackensack"],
  "New Mexico": ["Albuquerque","Las Cruces","Rio Rancho","Santa Fe","Roswell","Farmington","Hobbs","Clovis","Carlsbad","Alamogordo","Gallup","Los Lunas","Deming","Portales","Las Vegas"],
  "New York": ["New York","Buffalo","Rochester","Syracuse","Albany","Yonkers","New Rochelle","Mount Vernon","Utica","Schenectady","Binghamton","Niagara Falls","Troy","Saratoga Springs","Poughkeepsie"],
  "North Carolina": ["Charlotte","Raleigh","Greensboro","Durham","Winston-Salem","Fayetteville","Cary","Wilmington","High Point","Asheville","Greenville","Concord","Gastonia","Jacksonville","Chapel Hill"],
  "North Dakota": ["Fargo","Bismarck","Grand Forks","Minot","West Fargo","Williston","Dickinson","Mandan","Jamestown","Wahpeton","Devils Lake","Grafton","Lincoln","Beulah","Valley City"],
  "Ohio": ["Columbus","Cleveland","Cincinnati","Toledo","Akron","Dayton","Parma","Canton","Youngstown","Lorain","Hamilton","Springfield","Kettering","Elyria","Lakewood"],
  "Oklahoma": ["Oklahoma City","Tulsa","Norman","Broken Arrow","Edmond","Lawton","Moore","Midwest City","Enid","Stillwater","Muskogee","Bartlesville","Owasso","Shawnee","Ponca City"],
  "Oregon": ["Portland","Salem","Eugene","Gresham","Hillsboro","Beaverton","Bend","Medford","Springfield","Corvallis","Albany","Tigard","Lake Oswego","Keizer","Grants Pass"],
  "Pennsylvania": ["Philadelphia","Pittsburgh","Allentown","Erie","Reading","Scranton","Bethlehem","Lancaster","Harrisburg","York","Wilkes-Barre","Altoona","State College","Chester","Norristown"],
  "Rhode Island": ["Providence","Warwick","Cranston","Pawtucket","East Providence","Woonsocket","Newport","Central Falls","Westerly","Bristol","Coventry","North Providence","South Kingstown","Barrington","Smithfield"],
  "South Carolina": ["Columbia","Charleston","North Charleston","Mount Pleasant","Rock Hill","Greenville","Summerville","Spartanburg","Sumter","Hilton Head Island","Florence","Goose Creek","Aiken","Myrtle Beach","Anderson"],
  "South Dakota": ["Sioux Falls","Rapid City","Aberdeen","Brookings","Watertown","Mitchell","Yankton","Pierre","Spearfish","Huron","Vermillion","Brandon","Box Elder","Madison","Sturgis"],
  "Tennessee": ["Nashville","Memphis","Knoxville","Chattanooga","Clarksville","Murfreesboro","Franklin","Jackson","Johnson City","Bartlett","Hendersonville","Kingsport","Smyrna","Cleveland","Brentwood"],
  "Texas": ["Houston","San Antonio","Dallas","Austin","Fort Worth","El Paso","Arlington","Corpus Christi","Plano","Lubbock","Garland","Irving","Amarillo","Grand Prairie","Brownsville"],
  "Utah": ["Salt Lake City","West Valley City","Provo","St. George","Ogden","Sandy","Orem","Layton","South Jordan","Lehi","Logan","Murray","Taylorsville","Draper","Bountiful"],
  "Vermont": ["Burlington","South Burlington","Rutland","Barre","Montpelier","Essex","Saint Albans","Winooski","Bennington","Brattleboro","Colchester","Hartford","Stowe","Springfield","Middlebury"],
  "Virginia": ["Virginia Beach","Norfolk","Chesapeake","Richmond","Newport News","Alexandria","Hampton","Roanoke","Portsmouth","Suffolk","Lynchburg","Harrisonburg","Charlottesville","Danville","Manassas"],
  "Washington": ["Seattle","Spokane","Tacoma","Vancouver","Bellevue","Kent","Everett","Renton","Spokane Valley","Federal Way","Yakima","Bellingham","Auburn","Kennewick","Pasco"],
  "West Virginia": ["Charleston","Huntington","Morgantown","Parkersburg","Wheeling","Weirton","Fairmont","Beckley","Clarksburg","Martinsburg","South Charleston","Bluefield","Princeton","Vienna","Bridgeport"],
  "Wisconsin": ["Milwaukee","Madison","Green Bay","Kenosha","Racine","Appleton","Waukesha","Eau Claire","Oshkosh","Janesville","West Allis","La Crosse","Sheboygan","Wauwatosa","Fond du Lac"],
  "Wyoming": ["Cheyenne","Casper","Laramie","Gillette","Rock Springs","Sheridan","Green River","Evanston","Riverton","Jackson","Cody","Rawlins","Lander","Powell","Douglas"]
};

const jobs = {};

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function logEntry(jobId, message, type = 'info') {
  if (jobs[jobId]) {
    jobs[jobId].logs.push({ message, type, time: new Date().toISOString() });
  }
}

function runScraperProcess(state, cities, niche, maxPerCity, jobId, maxTotal = 1000) {
  return new Promise((resolve, reject) => {
    runScraper({ state, cities, niche, maxPerCity, maxTotal, onProgress: (type, data) => {
      if (!jobs[jobId]) return;
      if (type === 'business' && data.entry) {
        jobs[jobId].data.push(data.entry);
      } else if (type === 'progress') {
        jobs[jobId].totalBusinesses = data.totalBusinesses || 0;
        jobs[jobId].progress = data.percent || 0;
        jobs[jobId].elapsedSecs = data.elapsedSecs || 0;
        if (data.city) jobs[jobId].completedCities = cities.indexOf(data.city) + 1;
      } else if (type === 'status' && data.message) {
        logEntry(jobId, data.message, 'info');
      } else if (type === 'error' && data.message) {
        logEntry(jobId, data.message, 'error');
      }
    }})
      .then(data => resolve({ data }))
      .catch(err => {
        if (jobs[jobId]) jobs[jobId].status = 'error';
        reject(err);
      });
  });
}

app.put('/api/admin/users/:id/hold', requireAdmin, async (req, res) => {
  if (!process.env.MONGODB_URI) return res.status(503).json({ error: 'MongoDB required' });
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Cannot hold admin users' });
    const before = user.onHold;
    user.onHold = !user.onHold;
    await user.save();
    console.log(`[HOLD] ${user.username}: ${before} -> ${user.onHold}`);
    res.json({ _id: user._id, username: user.username, onHold: user.onHold });
  } catch (err) {
    console.error('[HOLD] Error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/scrape', requireAuth, checkScrapeLimit, async (req, res) => {
  const state = sanitize(req.body.state);
  const selectedCities = Array.isArray(req.body.cities) ? req.body.cities.map(sanitize).filter(Boolean) : [];
  const niche = sanitize(req.body.niche) || 'businesses';
  if (!PW_BROWSERS_READY) {
    return res.status(503).json({ error: 'Browser still downloading. Try again in 1-2 minutes.' });
  }
  if (!state || !CITIES[state]) {
    return res.status(400).json({ error: 'Invalid state selected' });
  }
  const allCities = CITIES[state];
  const targetCities = selectedCities && selectedCities.length > 0
    ? selectedCities
    : allCities;

  const jobId = genId();
  jobs[jobId] = {
    userId: req.userId,
    username: req.username,
    state,
    niche: (niche && niche.trim()) || 'businesses',
    status: 'running',
    cities: targetCities,
    progress: 0,
    totalCities: targetCities.length,
    completedCities: 0,
    data: [],
    totalBusinesses: 0,
    logs: [],
    startTime: Date.now(),
    elapsedSecs: 0,
    createdAt: new Date().toISOString()
  };

  logEntry(jobId, `Starting scrape for ${state} (${targetCities.length} cities)`, 'info');

  res.json({ jobId, totalCities: targetCities.length });

  const activeNiche = (niche && niche.trim()) ? niche.trim() : 'businesses';
  scrapeRunner(req.userId, jobId, state, targetCities, activeNiche).catch(err => {
    logEntry(jobId, `Fatal error: ${err.message}`, 'error');
    if (jobs[jobId]) jobs[jobId].status = 'error';
  });
});

async function scrapeRunner(userId, jobId, state, cities, niche = 'businesses') {
  try {
    logEntry(jobId, `Launching Playwright scraper for '${niche}'...`, 'info');

    const result = await runScraperProcess(state, cities, niche, 200, jobId, 1000);

    if (jobs[jobId]) {
      jobs[jobId].data = result.data || [];
      jobs[jobId].completedCities = cities.length;
      jobs[jobId].progress = 100;
    }
  } catch (err) {
    logEntry(jobId, `Scraper error: ${err.message}`, 'error');
    if (jobs[jobId]) jobs[jobId].status = 'error';
    return;
  }

  if (jobs[jobId] && jobs[jobId].status !== 'cancelled') {
    jobs[jobId].status = 'completed';
    try { await User.findByIdAndUpdate(userId, { $inc: { scrapeCount: 1 } }); } catch {} // increment daily scrape count

    const filename = `businesses_${state.replace(/\s+/g, '_')}_${jobId}.xlsx`;
    const filepath = path.join(JOBS_DIR, filename);

    try {
      const workbook = XLSX.utils.book_new();
      const data = jobs[jobId].data.length > 0
        ? jobs[jobId].data
        : [{ city: '', company: '', phone1: '', phone2: '', phone3: '', email1: '', email2: '', email3: '', website: '' }];
      const worksheet = XLSX.utils.json_to_sheet(data);

      const headers = ['City', 'Company Name', 'Email 1', 'Email 2', 'Email 3', 'Phone 1', 'Phone 2', 'Phone 3', 'Website'];
      XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: 'A1' });

      const colWidths = [
        { wch: 20 }, { wch: 35 },
        { wch: 35 }, { wch: 35 }, { wch: 35 },
        { wch: 18 }, { wch: 18 }, { wch: 18 },
        { wch: 40 }
      ];
      worksheet['!cols'] = colWidths;

      XLSX.utils.book_append_sheet(workbook, worksheet, 'Businesses');
      XLSX.writeFile(workbook, filepath);

      jobs[jobId].filename = filename;
      jobs[jobId].filepath = filepath;
      logEntry(jobId, `Excel file generated: ${filename}`, 'success');
      logEntry(jobId, `Total businesses scraped: ${jobs[jobId].data.length}`, 'success');
    } catch (err) {
      logEntry(jobId, `Failed to generate Excel: ${err.message}`, 'error');
      jobs[jobId].status = 'error';
    }
  }
}

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ status: 'not_found' });

  const now = Date.now();
  const elapsed = Math.floor((now - (job.startTime || now)) / 1000);
  const progressPct = job.progress || 0;
  let eta = null;
  if (progressPct > 0 && progressPct < 100) {
    const totalEstimated = Math.floor(elapsed / (progressPct / 100));
    eta = Math.max(0, totalEstimated - elapsed);
  }

  res.json({
    status: job.status,
    progress: job.progress,
    cities: job.cities,
    totalCities: job.totalCities,
    completedCities: job.completedCities,
    totalBusinesses: job.status === 'running' ? (job.totalBusinesses || 0) : job.data.length,
    data: job.data.slice(-50),
    logs: job.logs.slice(-100),
    filename: job.filename || null,
    elapsedSecs: elapsed,
    etaSecs: eta
  });
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.filename) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filepath = path.join(JOBS_DIR, job.filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.download(filepath, `Businesses_${job.state.replace(/\s+/g, '_')}.xlsx`);
});

function generateExcelForJob(jobId, job) {
  const filename = `businesses_${job.state.replace(/\s+/g, '_')}_${jobId}.xlsx`;
  const filepath = path.join(JOBS_DIR, filename);
  try {
    const workbook = XLSX.utils.book_new();
    const data = job.data.length > 0
      ? job.data
      : [{ city: '', company: '', phone1: '', phone2: '', phone3: '', email1: '', email2: '', email3: '', website: '' }];
    const worksheet = XLSX.utils.json_to_sheet(data);
    const headers = ['City', 'Company Name', 'Email 1', 'Email 2', 'Email 3', 'Phone 1', 'Phone 2', 'Phone 3', 'Website'];
    XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: 'A1' });
    worksheet['!cols'] = [
      { wch: 20 }, { wch: 35 },
      { wch: 35 }, { wch: 35 }, { wch: 35 },
      { wch: 18 }, { wch: 18 }, { wch: 18 },
      { wch: 40 }
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Businesses');
    XLSX.writeFile(workbook, filepath);
    job.filename = filename;
    job.filepath = filepath;
    return true;
  } catch {
    return false;
  }
}

app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (job && job.status === 'running') {
    job.status = 'cancelled';
    const ok = generateExcelForJob(req.params.jobId, job);
    if (ok && job.data.length > 0) {
      res.json({ status: 'cancelled', filename: job.filename, totalBusinesses: job.data.length });
    } else {
      res.json({ status: 'cancelled', totalBusinesses: 0 });
    }
  } else {
    res.json({ status: job ? job.status : 'not_found' });
  }
});

app.get('/api/cities', (req, res) => {
  const state = req.query.state;
  if (state && CITIES[state]) {
    res.json(CITIES[state]);
  } else {
    res.json([]);
  }
});

app.get('/api/states', (req, res) => {
  res.json(Object.keys(CITIES));
});

app.get('/api/estimate', (req, res) => {
  res.json({ maxLeads: 1000 });
});

const PROXY_FILE = path.join(__dirname, 'proxies.txt');
try {
  if (fs.existsSync(PROXY_FILE)) {
    const proxyCount = fs.readFileSync(PROXY_FILE, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    console.log(`Proxies: ${proxyCount} proxy entries found in proxies.txt`);
  } else {
    console.log('Proxies: no proxies.txt — running direct connections');
  }
} catch {}

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Network access: http://0.0.0.0:${PORT}`);
    console.log(`Scraper: ${path.join(__dirname, 'scraper.js')} (Node.js Playwright)`);
  });
}

module.exports = app;
