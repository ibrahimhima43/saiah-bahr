// server.js
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- load users (simple JSON DB)
let users = {};
try {
  if (fs.existsSync(USERS_FILE)) {
    const raw = fs.readFileSync(USERS_FILE, 'utf8') || '{}';
    users = JSON.parse(raw);
  } else {
    fs.writeFileSync(USERS_FILE, JSON.stringify({}), 'utf8');
    users = {};
  }
} catch (err) {
  console.error('Failed to load users.json', err);
  users = {};
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8'); }
  catch (e) { console.error('Failed to save users.json', e); }
}

// --- simple password hashing (salt + hmac-sha256)
function makeSalt(){ return crypto.randomBytes(12).toString('hex'); }
function hashPassword(password, salt){ return crypto.createHmac('sha256', salt).update(password).digest('hex'); }
function makeToken(){ return crypto.randomBytes(20).toString('hex'); }

// --- game static data (boats, fish, combos)
const boatsData = [
  { id:0, key:'boat', name:'قارب خشبي', cost:0 },
  { id:1, key:'skiff', name:'المركب', cost:300 },
  { id:2, key:'speedboat', name:'المركب السريع', cost:700 },
  { id:3, key:'sailboat', name:'المركب الشراعى', cost:1200 },
  { id:4, key:'fishing_v', name:'سفينة الصيد', cost:1500 },
  { id:5, key:'large_fishing', name:'سفينة صيد كبيرة', cost:4000 },
  { id:6, key:'ambush', name:'الكمين', cost:2200 },
  { id:7, key:'yacht', name:'اليخت', cost:8000 },
  { id:8, key:'dredger', name:'الحفارة', cost:10000 },
  { id:9, key:'icecruiser', name:'الثلجي', cost:9000 },
  { id:10, key:'exhibit', name:'معرض البحرية', cost:12000 },
  { id:11, key:'research', name:'مركز الأبحاث', cost:15000 },
  { id:12, key:'sub_basic', name:'غواصة', cost:50000 }
];

const fishTypes = [
  { id:0, name:"سمكة صغيرة", reward:8, chance:10 },
  { id:1, name:"سمكة عادية", reward:12, chance:10 },
  { id:2, name:"سمكة كبيرة", reward:18, chance:8 },
  { id:3, name:"البيرانا", reward:22, chance:6 },
  { id:4, name:"الماكريل", reward:28, chance:5 },
  { id:5, name:"قرش صغير", reward:40, chance:4 },
  { id:6, name:"زهرة القرن", reward:55, chance:2.5 },
  { id:7, name:"عنكبوت ياباني", reward:60, chance:1.8 },
  { id:8, name:"عنكبوت صيني", reward:65, chance:0.6 },
  { id:9, name:"مارلين", reward:80, chance:1.5 },
  { id:10, name:"حوت صغير", reward:180, chance:0.5 },
  { id:11, name:"حوت كبير", reward:350, chance:0.2 }
];

const combinations = [
  { combo:['ambush','ambush','skiff'], result:'عنكبوت ياباني' },
  { combo:['dredger','fishing_v','boat'], result:'زهرة القرن' },
  // (إمكان توسيع التركيبات لاحقًا)
];

// --- runtime state
const WORLD_W = 1200, WORLD_H = 700;
let players = {}; // socketId -> playerState
let fishes = [];  // {id,x,y,type,reward,ttl}
let bullets = []; // {id,owner,x,y,vx,vy,ttl}
let nextFishId = 1, nextBulletId = 1;

// --- weighted random helper
function weightedRandom(arr){
  const total = arr.reduce((s,a)=>s+(a.chance||1),0);
  let r = Math.random()*total, acc=0;
  for(const it of arr){ acc += (it.chance||1); if(r<=acc) return it; }
  return arr[0];
}

// --- spawn fish periodically
function spawnFish(){
  const t = weightedRandom(fishTypes);
  fishes.push({
    id: nextFishId++,
    x: Math.random()*WORLD_W,
    y: Math.random()*WORLD_H*0.6 + 50,
    type: t.id,
    reward: t.reward,
    ttl: 30000
  });
}
setInterval(spawnFish, 3000);

// --- main update loop (≈15fps)
setInterval(()=>{
  // update bullets
  bullets = bullets.filter(b=>{
    b.x += b.vx; b.y += b.vy; b.ttl -= 66;
    // check collision with players
    for(const pid in players){
      if(b.owner === pid) continue;
      const p = players[pid];
      if(!p) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if(d < 28){
        p.hp = Math.max(0, (p.hp||100)-25);
        b.ttl = 0;
      }
    }
    return b.ttl > 0;
  });

  // update fishes
  fishes = fishes.filter(f=>{
    f.ttl -= 66;
    f.x += (Math.random()-0.5)*1.6;
    if(f.x < 10) f.x = 10;
    if(f.x > WORLD_W-10) f.x = WORLD_W-10;
    return f.ttl > 0;
  });

  // broadcast state
  io.emit('state', { players, fishes, bullets });
}, 66);

// --- HTTP APIs: register / login / profile
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ ok:false, err:'missing' });
  if(users[username]) return res.status(400).json({ ok:false, err:'exists' });
  const salt = makeSalt(), hash = hashPassword(password, salt);
  const token = makeToken();
  users[username] = {
    salt, hash, token,
    data: {
      gold: 250,
      boats: [0],
      level: 1,
      fishesCaught: 0,
      daily: { last: null, streak: 0 }
    }
  };
  saveUsers();
  return res.json({ ok:true, token, username, data: users[username].data });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ ok:false, err:'missing' });
  const u = users[username];
  if(!u) return res.status(400).json({ ok:false, err:'no_user' });
  const h = hashPassword(password, u.salt);
  if(h !== u.hash) return res.status(400).json({ ok:false, err:'wrong' });
  u.token = makeToken();
  saveUsers();
  return res.json({ ok:true, token:u.token, username, data: u.data });
});

app.get('/api/profile', (req, res) => {
  const token = req.header('x-token') || req.query.token;
  if(!token) return res.status(401).json({ ok:false });
  const username = Object.keys(users).find(k => users[k].token === token);
  if(!username) return res.status(401).json({ ok:false });
  return res.json({ ok:true, username, data: users[username].data });
});

// --- socket authentication middleware (optional token)
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  socket.user = null;
  if(token){
    const username = Object.keys(users).find(k => users[k].token === token);
    if(username) socket.user = username;
  }
  next();
});

// --- socket handlers
io.on('connection', socket => {
  console.log('connect', socket.id, 'user=', socket.user || 'guest');
  // init player
  const base = {
    id: socket.id,
    name: socket.user || ('لاعب-'+socket.id.slice(0,4)),
    x: Math.random()*800 + 100,
    y: Math.random()*300 + 200,
    angle:0, gold:250, boats:[0], selectedBoat:0, hp:100, energy:100, fishesCaught:0, lastSeen: Date.now()
  };
  if(socket.user && users[socket.user] && users[socket.user].data){
    const d = users[socket.user].data;
    base.gold = (d.gold !== undefined) ? d.gold : base.gold;
    base.boats = d.boats || base.boats;
    base.level = d.level || 1;
    base.fishesCaught = d.fishesCaught || 0;
  }
  players[socket.id] = base;

  socket.emit('welcome', { id: socket.id, boatsData, fishTypes, combinations, user: socket.user });

  socket.on('update', data => {
    const p = players[socket.id]; if(!p) return;
    p.x = Math.max(0, Math.min(WORLD_W, Number(data.x) || p.x));
    p.y = Math.max(0, Math.min(WORLD_H, Number(data.y) || p.y));
    p.angle = data.angle || p.angle;
    p.lastSeen = Date.now();
  });

  socket.on('shoot', payload => {
    const p = players[socket.id]; if(!p) return;
    const speed = 12;
    const dx = payload.tx - p.x, dy = payload.ty - p.y;
    const mag = Math.max(0.0001, Math.hypot(dx,dy));
    bullets.push({ id: nextBulletId++, owner: socket.id, x: p.x, y: p.y, vx: dx/mag*speed, vy: dy/mag*speed, ttl: 3000 });
  });

  socket.on('catchFish', fid => {
    const p = players[socket.id]; if(!p) return;
    const idx = fishes.findIndex(f=>f.id === fid);
    if(idx === -1) return;
    const f = fishes[idx];
    const dist = Math.hypot(p.x - f.x, p.y - f.y);
    if(dist < 120){
      p.gold = (p.gold||0) + f.reward;
      p.fishesCaught = (p.fishesCaught||0) + 1;
      socket.emit('caught', { fish: f });
      fishes.splice(idx,1);
      // persist if logged in
      if(socket.user) {
        users[socket.user].data.gold = p.gold;
        users[socket.user].data.boats = p.boats;
        users[socket.user].data.fishesCaught = p.fishesCaught;
        saveUsers();
      }
      console.log(`player ${socket.id} caught fish ${f.id} reward ${f.reward}`);
    }
  });

  socket.on('buyBoat', bid => {
    const p = players[socket.id]; if(!p) return;
    const boat = boatsData.find(b=>b.id===bid); if(!boat) return;
    if(p.boats.length >= 3) { socket.emit('buyResult',{ok:false,reason:'max'}); return; }
    if(p.gold >= boat.cost){ p.gold -= boat.cost; p.boats.push(boat.id); socket.emit('buyResult',{ok:true,boat}); if(socket.user){ users[socket.user].data.gold = p.gold; users[socket.user].data.boats = p.boats; saveUsers(); } }
    else socket.emit('buyResult',{ok:false,reason:'funds'});
  });

  socket.on('disconnect', () => {
    // persist on disconnect
    const p = players[socket.id];
    if(p && socket.user){
      users[socket.user].data.gold = p.gold;
      users[socket.user].data.boats = p.boats;
      users[socket.user].data.fishesCaught = p.fishesCaught;
      saveUsers();
    }
    delete players[socket.id];
    console.log('disconnect', socket.id);
  });
});

// start server
server.listen(PORT, ()=> console.log(`Server running on http://localhost:${PORT}`));
