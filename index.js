import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

/* ───────────── Config ───────────── */

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // optional: instant command updates in one server
const DB_PATH = process.env.DB_PATH || './data/orbs.db';
const SALARY_INTERVAL_MIN = Number(process.env.SALARY_INTERVAL_MINUTES) || 60;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

// Supply: starts at START_SUPPLY, grows linearly to TARGET_SUPPLY over SUPPLY_DAYS
// (and keeps growing at the same daily rate afterwards).
const START_SUPPLY = 500_000_000;
const TARGET_SUPPLY = 2_000_000_000_000;
const SUPPLY_DAYS = 180;
const DAILY_ADD = (TARGET_SUPPLY - START_SUPPLY) / SUPPLY_DAYS; // ~11.1 billion/day
const SCALE_PAYOUTS = true; // earn payouts grow with the supply so the economy keeps up
const PRICE_SCALE = 0.04; // shop prices gain 4% per doubling of the supply cap (2T cap ≈ +48%)

const PAY_TAX = 0.1; // share of each /pay removed from circulation (back into the vault)
const DAILY_BASE = 500;
const DAILY_STEP = 100; // extra per streak day
const DAILY_MAX_STREAK = 10; // streak bonus stops growing after this many days
const DAY_SECONDS = 24 * 60 * 60; // /daily resets at UTC midnight
const MAX_TOOL_LEVEL = 5;
const MAX_LEVEL = 50;
const XP_BASE = 500; // level L begins at XP_BASE * (L-1)^2 xp
const MAX_PRESTIGE = 10;
const PRESTIGE_BONUS = 0.02; // +2% earn payouts per prestige
const DROP_CHANNEL_ID = process.env.DROP_CHANNEL_ID; // optional: where orb drops appear
const DROP_BASE = 1000;
const DROP_MIN_MINUTES = 20;
const DROP_MAX_MINUTES = 40;
const DROP_EXPIRE_SECONDS = 10 * 60;
const DROP_WAIT = 5; // drops you must sit out after winning one
const CLAN_PRICE = 25_000; // to found a clan; scales like shop prices
const CLAN_MAX_MEMBERS = 20;
const CLAN_MAX_LEVEL = 5;
const CLAN_BONUS = 0.01; // +1% earn payouts per clan level, for every member
const CLAN_UPGRADE_BASE = 50_000; // level L -> L+1 costs this x 3^L; scales like shop prices
const CLAN_INVITE_DAYS = 7;
const EVENT_CHANNEL_ID = process.env.EVENT_CHANNEL_ID || DROP_CHANNEL_ID; // raids and event announcements
const RAID_HOURS = 48; // time to defeat the boss
const RAID_GAP_HOURS = 72; // quiet time after a raid ends before the next one spawns
const RAID_HP_PER_MEMBER = 300;
const RAID_MIN_HP = 3_000;
const RAID_POOL = 50_000; // shared reward, split by damage; scales with payouts
const RAID_DAMAGE = { work: 10, build: 15, fish: 8, mine: 20, quiz: 20, daily: 25, drop: 15 };
const RAID_CRIT = 0.1; // chance of a double-damage hit
const RAID_BOSSES = ['😈 Demon Guardian', '🔥 Lava Pit Demon', '🗝️ Vault Keeper', '💀 Nine Circles Wraith'];

// Anti-AFK / anti-bot checks
const CHALLENGE_CHANCE = 0.2; // random chance per earn command
const FORCE_AFTER = 10; // always check after this many earns without one
const CHALLENGE_SECONDS = 30; // time to answer
const TRIVIA_SECONDS = 10; // trivia questions are quick reads
const QUIZ_SKIPS = 3; // skips per /quiz, each one rerolls the question
const DIFF_MULT = { 1: 0.5, 2: 1, 3: 2, 4: 3 }; // /quiz payout by question difficulty
const MAX_FAILS = 3; // fails before lockout
const LOCK_SECONDS = 60 * 60; // lockout length

const ORB = '🟠';
const COLOR = 0xffa500;
const EPH = MessageFlags.Ephemeral;

const SHOP = {
  image_perms: {
    name: '🖼️ Image Permissions',
    desc: 'Post images and attachments in chat.',
    price: 1000,
    roleEnv: 'IMAGE_ROLE_ID',
  },
  admin_perms: {
    name: '👑 Admin Permissions',
    desc: 'Full admin on the server. Only for true Demon-tier players.',
    price: Number(process.env.ADMIN_PRICE) || 1_000_000_000_000, // 1 trillion
    roleEnv: 'ADMIN_ROLE_ID',
  },
  salary_raise: {
    name: '💰 Salary Raise',
    desc: '+5% on your role salary. Needs a paid salary. Doesn\'t stack with Good Resumé.',
    price: 20_000,
    salaryBoost: 0.05,
  },
  good_resume: {
    name: '📄 Good Resumé',
    desc: '+25% on your role salary. Needs a paid salary. Replaces the Salary Raise.',
    price: 500_000,
    salaryBoost: 0.25,
  },
  diamond_pickaxe: {
    name: '💎 Diamond Pickaxe',
    desc: 'Random +2-10% on every /mine payout. Each /upgrade raises the top of the range by 5%.',
    price: 5_000,
    perk: { action: 'mine', min: 2, max: 10, step: 5 },
  },
  good_rod: {
    name: '🎣 Good Fishing Rod',
    desc: 'Random +2-15% on every /fish payout. Each /upgrade raises the top of the range by 5%.',
    price: 4_000,
    perk: { action: 'fish', min: 2, max: 15, step: 5 },
  },
};

const ACTIONS = {
  work: {
    emoji: '🔨',
    verb: 'working',
    cooldown: 5 * 60,
    min: 80,
    max: 200,
    bonusChance: 0.05,
    bonusMult: 3,
    bonusText: 'RobTop noticed your work!',
    lines: [
      'You tested levels for the Geometry Dash team',
      'You verified an Extreme Demon without a single crash',
      'You moderated the level rating queue',
      'You synced a song to a Stereo Madness remake',
      'You designed a portal for a Hall of Fame level',
    ],
  },
  build: {
    emoji: '🧱',
    verb: 'building',
    cooldown: 10 * 60,
    min: 150,
    max: 400,
    bonusChance: 0.07,
    bonusMult: 3,
    bonusText: 'Your level got Featured!',
    lines: [
      'You built a 2.2 platformer level in the editor',
      'You decorated a level with way too many triggers',
      'You layered a glowing deco section around a spike pit',
      'You finished a collab part and got paid',
      'You built a Mega Collab segment',
    ],
  },
  fish: {
    emoji: '🎣',
    verb: 'fishing',
    cooldown: 3 * 60,
    min: 40,
    max: 150,
    bonusChance: 0.08,
    bonusMult: 4,
    bonusText: 'You hooked a golden Mana Orb!',
    lines: [
      'You fished in the Lava Pit and pulled up orbs',
      'You cast a line into the Nine Circles',
      'You reeled in a school of tiny orbs',
      'You caught a glowing orb near the Treasure Room',
      'You fished beside the Secret Vault',
    ],
  },
  mine: {
    emoji: '⛏️',
    verb: 'mining',
    cooldown: 15 * 60,
    min: 200,
    max: 600,
    bonusChance: 0.05,
    bonusMult: 5,
    bonusText: 'You found a Vault diamond cache!',
    lines: [
      'You mined deep under the Vault of Secrets',
      'You dug through the Chamber of Time',
      'You mined orbs out of the Demon Guardian\'s lair',
      'You cracked open a Gold Chest full of orbs',
      'You mined in the Treasure Room with the Keymaster',
    ],
  },
  quiz: {
    emoji: '❓',
    verb: 'answering Geometry Dash trivia',
    cooldown: 3 * 60,
    min: 200,
    max: 500,
    bonusChance: 0.05,
    bonusMult: 3,
    bonusText: 'Perfect recall!',
    trivia: true, // always a trivia question, never math or symbols
    lines: [
      'You aced a Geometry Dash quiz',
      'You knew the answer to a level history question',
      'You remembered the official level order',
    ],
  },
};

// Unlocked once each. `stat` is a counter bumped by play (see afterEarn); rewards scale with payouts.
const ACHIEVEMENTS = [
  { key: 'first_orbs', name: '👣 First Orbs', desc: 'Earn orbs from any earn command', stat: 'earns', goal: 1, reward: 100 },
  { key: 'grinder', name: '⚙️ Grinder', desc: 'Get paid from earn commands 500 times', stat: 'earns', goal: 500, reward: 10_000 },
  { key: 'hard_worker', name: '🔨 Hard Worker', desc: 'Get paid from /work 100 times', stat: 'work', goal: 100, reward: 2_000 },
  { key: 'architect', name: '🧱 Architect', desc: 'Get paid from /build 100 times', stat: 'build', goal: 100, reward: 3_000 },
  { key: 'angler', name: '🎣 Angler', desc: 'Get paid from /fish 100 times', stat: 'fish', goal: 100, reward: 1_500 },
  { key: 'deep_miner', name: '⛏️ Deep Miner', desc: 'Get paid from /mine 100 times', stat: 'mine', goal: 100, reward: 4_000 },
  { key: 'quiz_whiz', name: '🧠 Quiz Whiz', desc: 'Answer 50 quizzes correctly', stat: 'quiz', goal: 50, reward: 3_000 },
  { key: 'on_a_roll', name: '🔥 On a Roll', desc: 'Answer 20 quizzes in a row without a miss', stat: 'quiz_streak', goal: 20, reward: 5_000 },
  { key: 'demon_brain', name: '😈 Demon Brain', desc: 'Answer 10 four-star quiz questions', stat: 'quiz_hard', goal: 10, reward: 4_000 },
  { key: 'quick_hands', name: '⚡ Quick Hands', desc: 'Win 5 orb drops', stat: 'drop', goal: 5, reward: 2_500 },
  { key: 'dedicated', name: '📅 Dedicated', desc: 'Reach a 30-day /daily streak', stat: 'daily_streak', goal: 30, reward: 10_000 },
  { key: 'founder', name: '🏰 Founder', desc: 'Found a clan', stat: 'clan_founded', goal: 1, reward: 1_000 },
  { key: 'demon_slayer', name: '🗡️ Demon Slayer', desc: 'Help defeat 3 raid bosses', stat: 'raids_won', goal: 3, reward: 5_000 },
];

/* ───────────── Database ───────────── */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);
CREATE TABLE IF NOT EXISTS purchases (
  user_id TEXT NOT NULL, item TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, item)
);
CREATE TABLE IF NOT EXISTS salaries (
  guild_id TEXT NOT NULL, role_id TEXT NOT NULL, amount INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS strikes (
  user_id TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tools (
  user_id TEXT NOT NULL, tool TEXT NOT NULL, level INTEGER NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS daily (
  user_id TEXT PRIMARY KEY, last_day INTEGER NOT NULL, streak INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, prestige INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS drop_wins (
  user_id TEXT PRIMARY KEY, seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  user_id TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, owner_id TEXT NOT NULL,
  treasury INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
  contributed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
  UNIQUE (guild_id, name)
);
CREATE TABLE IF NOT EXISTS clan_members (
  user_id TEXT PRIMARY KEY, clan_id INTEGER NOT NULL, joined INTEGER NOT NULL,
  contributed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clan_invites (
  clan_id INTEGER NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (clan_id, user_id)
);
CREATE TABLE IF NOT EXISTS raids (
  guild_id TEXT PRIMARY KEY, boss TEXT NOT NULL, hp INTEGER NOT NULL, max_hp INTEGER NOT NULL,
  ends INTEGER NOT NULL, channel_id TEXT NOT NULL, message_id TEXT
);
CREATE TABLE IF NOT EXISTS raid_damage (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, dmg INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);

const q = {
  ensure: db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)'),
  bal: db.prepare('SELECT balance FROM users WHERE id = ?'),
  add: db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?'),
  sub: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?'),
  refund: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
  top: db.prepare('SELECT id, balance FROM users WHERE balance > 0 ORDER BY balance DESC LIMIT 10'),
  getCd: db.prepare('SELECT ts FROM cooldowns WHERE user_id = ? AND action = ?'),
  setCd: db.prepare('INSERT OR REPLACE INTO cooldowns (user_id, action, ts) VALUES (?, ?, ?)'),
  hasItem: db.prepare('SELECT 1 FROM purchases WHERE user_id = ? AND item = ?'),
  addItem: db.prepare('INSERT INTO purchases (user_id, item, ts) VALUES (?, ?, ?)'),
  delItem: db.prepare('DELETE FROM purchases WHERE user_id = ? AND item = ?'),
  setSalary: db.prepare('INSERT OR REPLACE INTO salaries (guild_id, role_id, amount) VALUES (?, ?, ?)'),
  delSalary: db.prepare('DELETE FROM salaries WHERE guild_id = ? AND role_id = ?'),
  salaries: db.prepare('SELECT role_id, amount FROM salaries WHERE guild_id = ? ORDER BY amount DESC'),
  getStrike: db.prepare('SELECT fails, locked_until, streak FROM strikes WHERE user_id = ?'),
  upsertStrike: db.prepare('INSERT OR REPLACE INTO strikes (user_id, fails, locked_until, streak) VALUES (?, ?, ?, ?)'),
  circ: db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users'),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  getTool: db.prepare('SELECT level FROM tools WHERE user_id = ? AND tool = ?'),
  setTool: db.prepare('INSERT OR REPLACE INTO tools (user_id, tool, level) VALUES (?, ?, ?)'),
  getDaily: db.prepare('SELECT last_day, streak FROM daily WHERE user_id = ?'),
  setDaily: db.prepare('INSERT OR REPLACE INTO daily (user_id, last_day, streak) VALUES (?, ?, ?)'),
  getProg: db.prepare('SELECT xp, prestige FROM progress WHERE user_id = ?'),
  addXp: db.prepare('INSERT INTO progress (user_id, xp, prestige) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp'),
  resetXp: db.prepare('UPDATE progress SET xp = 0, prestige = prestige + 1 WHERE user_id = ?'),
  getWin: db.prepare('SELECT seq FROM drop_wins WHERE user_id = ?'),
  setWin: db.prepare('INSERT OR REPLACE INTO drop_wins (user_id, seq) VALUES (?, ?)'),
  getStat: db.prepare('SELECT n FROM stats WHERE user_id = ? AND key = ?'),
  addStat: db.prepare('INSERT INTO stats (user_id, key, n) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET n = n + excluded.n RETURNING n'),
  maxStat: db.prepare('INSERT INTO stats (user_id, key, n) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET n = MAX(n, excluded.n) RETURNING n'),
  setStat: db.prepare('INSERT OR REPLACE INTO stats (user_id, key, n) VALUES (?, ?, ?)'),
  addAch: db.prepare('INSERT OR IGNORE INTO achievements (user_id, key, ts) VALUES (?, ?, ?)'),
  userAchs: db.prepare('SELECT key FROM achievements WHERE user_id = ?'),
  clanOf: db.prepare('SELECT c.* FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = ?'),
  clanByName: db.prepare('SELECT * FROM clans WHERE guild_id = ? AND name = ?'),
  newClan: db.prepare('INSERT INTO clans (guild_id, name, owner_id, created) VALUES (?, ?, ?, ?)'),
  delClan: db.prepare('DELETE FROM clans WHERE id = ?'),
  delClanInvites: db.prepare('DELETE FROM clan_invites WHERE clan_id = ?'),
  setClanOwner: db.prepare('UPDATE clans SET owner_id = ? WHERE id = ?'),
  addMember: db.prepare('INSERT INTO clan_members (user_id, clan_id, joined) VALUES (?, ?, ?)'),
  delMember: db.prepare('DELETE FROM clan_members WHERE user_id = ?'),
  clanMembers: db.prepare('SELECT user_id, contributed FROM clan_members WHERE clan_id = ? ORDER BY joined, rowid'),
  clanSize: db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?'),
  addInvite: db.prepare('INSERT OR REPLACE INTO clan_invites (clan_id, user_id, ts) VALUES (?, ?, ?)'),
  getInvite: db.prepare('SELECT ts FROM clan_invites WHERE clan_id = ? AND user_id = ?'),
  delInvite: db.prepare('DELETE FROM clan_invites WHERE clan_id = ? AND user_id = ?'),
  clanDeposit: db.prepare('UPDATE clans SET treasury = treasury + ?, contributed = contributed + ? WHERE id = ?'),
  memberDeposit: db.prepare('UPDATE clan_members SET contributed = contributed + ? WHERE user_id = ?'),
  clanLevelUp: db.prepare('UPDATE clans SET treasury = treasury - @cost, level = level + 1 WHERE id = @id AND treasury >= @cost AND level < @max'),
  topClans: db.prepare('SELECT * FROM clans WHERE guild_id = ? ORDER BY level DESC, contributed DESC LIMIT 10'),
  getRaid: db.prepare('SELECT * FROM raids WHERE guild_id = ?'),
  newRaid: db.prepare('INSERT INTO raids (guild_id, boss, hp, max_hp, ends, channel_id) VALUES (?, ?, ?, ?, ?, ?)'),
  setRaidMsg: db.prepare('UPDATE raids SET message_id = ? WHERE guild_id = ?'),
  hitRaid: db.prepare('UPDATE raids SET hp = MAX(0, hp - @dmg) WHERE guild_id = @guild AND hp > 0 AND ends > @now RETURNING hp'),
  addDamage: db.prepare('INSERT INTO raid_damage (guild_id, user_id, dmg) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET dmg = dmg + excluded.dmg'),
  raidDamage: db.prepare('SELECT user_id, dmg FROM raid_damage WHERE guild_id = ? ORDER BY dmg DESC'),
  delRaid: db.prepare('DELETE FROM raids WHERE guild_id = ?'),
  delRaidDamage: db.prepare('DELETE FROM raid_damage WHERE guild_id = ?'),
};

const getBalance = (id) => q.bal.get(id)?.balance ?? 0;

function supplyStart() {
  const row = q.getMeta.get('supply_start');
  if (row) return Number(row.value);
  const t = Math.floor(Date.now() / 1000);
  q.setMeta.run('supply_start', String(t));
  return t;
}
const supplyCap = () =>
  Math.floor(START_SUPPLY + (DAILY_ADD * (Math.floor(Date.now() / 1000) - supplyStart())) / 86400);
const circulating = () => q.circ.get().s;
const mintable = () => Math.max(0, supplyCap() - circulating());
const payoutMultiplier = () => (SCALE_PAYOUTS ? Math.max(1, supplyCap() / START_SUPPLY) : 1);
// Prices rise only slowly with the cap, unlike payouts which scale linearly.
const priceMult = () => 1 + PRICE_SCALE * Math.log2(Math.max(1, supplyCap() / START_SUPPLY));
const priceOf = (key) => Math.ceil(SHOP[key].price * priceMult());

// Orbs can only be minted while circulation is below the cap. Returns what was actually granted.
const mintTx = db.transaction((uid, amount) => {
  q.ensure.run(uid);
  const granted = Math.max(0, Math.min(amount, mintable()));
  if (granted > 0) {
    q.add.run(granted, granted, uid);
    q.addXp.run(uid, granted);
  }
  return granted;
});

const earnTx = db.transaction((uid, action, amount, now) => {
  q.setCd.run(uid, action, now);
  return mintTx(uid, amount);
});

// Returns the amount the receiver got (after tax), 0 if the tax would eat the whole transfer,
// or false if the sender is short. Tax rounds up so small transfers can't dodge it.
const transferTx = db.transaction((from, to, amount) => {
  q.ensure.run(from);
  q.ensure.run(to);
  if (getBalance(from) < amount) return false;
  const received = amount - Math.ceil(amount * PAY_TAX);
  if (received <= 0) return 0;
  q.sub.run(amount, from); // the tax is never credited to anyone, so it goes back to the vault
  q.refund.run(received, to);
  return received;
});

const upgradeTx = db.transaction((uid, key, cost, level) => {
  if (getBalance(uid) < cost) return 'poor';
  q.sub.run(cost, uid);
  q.setTool.run(uid, key, level + 1);
  return 'ok';
});

const buyTx = db.transaction((uid, key, price, now) => {
  if (q.hasItem.get(uid, key)) return 'owned';
  q.ensure.run(uid);
  if (getBalance(uid) < price) return 'poor';
  q.sub.run(price, uid);
  q.addItem.run(uid, key, now);
  return 'ok';
});

const undoBuyTx = db.transaction((uid, key, price) => {
  q.delItem.run(uid, key);
  q.refund.run(price, uid);
});

const createClanTx = db.transaction((uid, guildId, name, price, now) => {
  if (q.clanOf.get(uid)) return 'inclan';
  if (q.clanByName.get(guildId, name)) return 'taken';
  q.ensure.run(uid);
  if (getBalance(uid) < price) return 'poor';
  q.sub.run(price, uid);
  const id = q.newClan.run(guildId, name, uid, now).lastInsertRowid;
  q.addMember.run(uid, id, now);
  return 'ok';
});

const joinClanTx = db.transaction((uid, clan, now) => {
  if (q.clanOf.get(uid)) return 'inclan';
  const invite = q.getInvite.get(clan.id, uid);
  if (!invite || now - invite.ts > CLAN_INVITE_DAYS * DAY_SECONDS) return 'noinvite';
  if (q.clanSize.get(clan.id).n >= CLAN_MAX_MEMBERS) return 'full';
  q.addMember.run(uid, clan.id, now);
  q.delInvite.run(clan.id, uid);
  return 'ok';
});

// The longest-standing member takes over when the owner leaves; an empty clan is disbanded.
const leaveClanTx = db.transaction((uid, clan) => {
  q.delMember.run(uid);
  if (clan.owner_id !== uid) return { result: 'left' };
  const next = q.clanMembers.all(clan.id)[0];
  if (!next) {
    q.delClanInvites.run(clan.id);
    q.delClan.run(clan.id);
    return { result: 'disbanded' };
  }
  q.setClanOwner.run(next.user_id, clan.id);
  return { result: 'transferred', owner: next.user_id };
});

// Deposits can't be withdrawn, so a clan can't be used to dodge the /pay tax.
const depositTx = db.transaction((uid, clanId, amount) => {
  if (getBalance(uid) < amount) return false;
  q.sub.run(amount, uid);
  q.clanDeposit.run(amount, amount, clanId);
  q.memberDeposit.run(amount, uid);
  return true;
});

// Returns a Map of what each player was actually paid.
const payoutTx = db.transaction((payouts) => {
  const total = payouts.reduce((n, [, a]) => n + a, 0);
  const avail = mintable();
  const ratio = total > avail ? avail / total : 1; // share what's left if the vault is short
  const paid = new Map();
  for (const [uid, amount] of payouts) {
    const amt = Math.floor(amount * ratio);
    if (amt <= 0) continue;
    q.ensure.run(uid);
    q.add.run(amt, amt, uid);
    q.addXp.run(uid, amt);
    paid.set(uid, amt);
  }
  return paid;
});

// Removes the raid and its damage table in one step, so a boss can only be settled once.
const closeRaidTx = db.transaction((guildId) => {
  const raid = q.getRaid.get(guildId);
  if (!raid) return null;
  const dealers = q.raidDamage.all(guildId);
  q.delRaid.run(guildId);
  q.delRaidDamage.run(guildId);
  return { raid, dealers };
});

/* ───────────── Helpers ───────────── */

const fmt = (n) => n.toLocaleString('en-US');
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const nowSec = () => Math.floor(Date.now() / 1000);
const embed = (desc, title) => {
  const e = new EmbedBuilder().setColor(COLOR).setDescription(desc);
  if (title) e.setTitle(title);
  return e;
};
const fail = (i, msg) => {
  const payload = { content: `❌ ${msg}` };
  return i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, flags: EPH });
};

// Salary boosts don't stack: the best owned one applies.
const salaryBoost = (uid) =>
  Math.max(0, ...Object.entries(SHOP).filter(([k, s]) => s.salaryBoost && q.hasItem.get(uid, k)).map(([, s]) => s.salaryBoost));

// True if the member holds any role that has a /salary payout in this guild.
const hasPaidSalary = (member, guildId) =>
  q.salaries.all(guildId).some((r) => member.roles.cache.has(r.role_id));

// Tools bought before upgrades existed have no tools row, so they count as level 1.
const toolLevel = (uid, key) => q.getTool.get(uid, key)?.level ?? (q.hasItem.get(uid, key) ? 1 : 0);
const toolRange = (key, level) => {
  const p = SHOP[key].perk;
  return `+${p.min}-${p.max + p.step * (level - 1)}%`;
};
const upgradeCost = (key, level) => Math.ceil(priceOf(key) * 2 ** level);

const levelOf = (xp) => Math.min(MAX_LEVEL, Math.floor(Math.sqrt(xp / XP_BASE)) + 1);
const progressOf = (uid) => q.getProg.get(uid) ?? { xp: 0, prestige: 0 };
const prestigeBonus = (uid) => progressOf(uid).prestige * PRESTIGE_BONUS;
const clanBonus = (uid) => (q.clanOf.get(uid)?.level ?? 0) * CLAN_BONUS;
const clanPrice = () => Math.ceil(CLAN_PRICE * priceMult());
const clanUpgradeCost = (level) => Math.ceil(CLAN_UPGRADE_BASE * 3 ** level * priceMult());

/* ───────────── Stats, achievements and play hooks ───────────── */

// Bumps a player stat and unlocks any achievement it completes. Unlock lines go into notes.
function bumpStat(uid, key, by, notes, mode = 'add') {
  const n = (mode === 'max' ? q.maxStat : q.addStat).get(uid, key, by).n;
  for (const a of ACHIEVEMENTS) {
    if (a.stat !== key || n < a.goal) continue;
    if (q.addAch.run(uid, a.key, nowSec()).changes === 0) continue; // already unlocked
    const granted = mintTx(uid, Math.floor(a.reward * payoutMultiplier()));
    notes.push(`🏅 Achievement unlocked: **${a.name}**${granted ? ` (+${fmt(granted)} ${ORB})` : ''}`);
  }
  return n;
}

// Runs after orbs are earned through play: earn commands, /daily, drops and events.
// Salaries and /pay don't count. `events` are stat keys bumped by one (e.g. ['earns', 'mine']).
// Feature hooks (raids, coins, weekly goals, seasons) push extra lines into notes for the reply.
const earnHooks = [];
function afterEarn(uid, guildId, events, granted, notes = []) {
  for (const e of events) bumpStat(uid, e, 1, notes);
  for (const hook of earnHooks) hook({ uid, guildId, events, granted, notes });
  return notes;
}

const earnEvents = (name, difficulty) => {
  const events = ['earns', name];
  if (name === 'quiz') events.push('quiz_streak');
  if (name === 'quiz' && difficulty === 4) events.push('quiz_hard');
  return events;
};
const withNotes = (text, notes) => (notes.length ? `${text}\n\n${notes.join('\n')}` : text);

/* ───────────── Commands ───────────── */

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your mana orbs')
    .addUserOption((o) => o.setName('user').setDescription('Someone else')),
  ...Object.keys(ACTIONS).map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(`${ACTIONS[name].emoji} Earn mana orbs by ${ACTIONS[name].verb}`)
  ),
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Send mana orbs to another player')
    .addUserOption((o) => o.setName('user').setDescription('Who to pay').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('Orbs to send').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('supply').setDescription('See how many orbs exist and are left to earn'),
  new SlashCommandBuilder().setName('shop').setDescription('See what you can buy'),
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy something from the shop')
    .addStringOption((o) =>
      o
        .setName('item')
        .setDescription('What to buy')
        .setRequired(true)
        .addChoices(...Object.entries(SHOP).map(([value, s]) => ({ name: s.name, value })))
    ),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Richest players'),
  new SlashCommandBuilder().setName('daily').setDescription('Claim your daily orbs. Keep a streak for bigger rewards'),
  new SlashCommandBuilder()
    .setName('upgrade')
    .setDescription('Upgrade a tool for a bigger payout')
    .addStringOption((o) =>
      o
        .setName('tool')
        .setDescription('Which tool')
        .setRequired(true)
        .addChoices(...Object.entries(SHOP).filter(([, s]) => s.perk).map(([value, s]) => ({ name: s.name, value })))
    ),
  new SlashCommandBuilder().setName('changelog').setDescription('Show the latest update to the bot'),
  new SlashCommandBuilder().setName('level').setDescription('See your level, XP and prestige'),
  new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Team up with other players')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Found a clan')
        .addStringOption((o) => o.setName('name').setDescription('Letters, numbers and spaces').setRequired(true).setMinLength(3).setMaxLength(24))
    )
    .addSubcommand((s) =>
      s.setName('invite').setDescription('Invite a player (owner only)').addUserOption((o) => o.setName('user').setDescription('Who to invite').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('join').setDescription('Join a clan that invited you').addStringOption((o) => o.setName('name').setDescription('Clan name').setRequired(true))
    )
    .addSubcommand((s) => s.setName('leave').setDescription('Leave your clan'))
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Remove a member (owner only)').addUserOption((o) => o.setName('user').setDescription('Who to remove').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('deposit')
        .setDescription('Put orbs into the clan upgrade fund (cannot be withdrawn)')
        .addIntegerOption((o) => o.setName('amount').setDescription('Orbs to deposit').setRequired(true).setMinValue(1))
    )
    .addSubcommand((s) => s.setName('upgrade').setDescription('Spend the fund on the next clan level (owner only)'))
    .addSubcommand((s) =>
      s.setName('info').setDescription('See a clan').addStringOption((o) => o.setName('name').setDescription('Clan name (default: yours)'))
    )
    .addSubcommand((s) => s.setName('top').setDescription('Top clans')),
  new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Fight the raid boss together')
    .addSubcommand((s) => s.setName('status').setDescription('Boss HP and top hitters'))
    .addSubcommand((s) => s.setName('start').setDescription('Summon a boss in this channel now (Manage Server)')),
  new SlashCommandBuilder()
    .setName('achievements')
    .setDescription('See unlocked achievements and progress')
    .addUserOption((o) => o.setName('user').setDescription('Someone else')),
  new SlashCommandBuilder().setName('prestige').setDescription(`Reset your level for a permanent payout bonus (needs level ${MAX_LEVEL})`),
  new SlashCommandBuilder()
    .setName('salary')
    .setDescription('Manage automatic role payments')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set the payout for a role')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Orbs per payout').setRequired(true).setMinValue(1))
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a role payout')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show role payouts')),
].map((c) => c.toJSON());

/* ───────────── Anti-bot challenges ───────────── */

const pending = new Map(); // challengeId -> { userId, reward, answer, timer }

const shuffle = (arr) => {
  const a = [...arr];
  for (let n = a.length - 1; n > 0; n--) {
    const m = Math.floor(Math.random() * (n + 1));
    [a[n], a[m]] = [a[m], a[n]];
  }
  return a;
};

const TRIVIA = [
  // difficulty 1
  { q: 'Which is the first official Geometry Dash level?', a: 'Stereo Madness', w: ['Back On Track', 'Polargeist', 'Dry Out'], d: 1 },
  { q: 'Who created Geometry Dash?', a: 'RobTop', w: ['Zobros', 'Riot', 'Hinds'], d: 1 },
  { q: 'Which game mode flies like a rocket?', a: 'Ship', w: ['Cube', 'Ball', 'Wave'], d: 1 },
  { q: 'Which game mode zig-zags diagonally?', a: 'Wave', w: ['Cube', 'Ship', 'Ball'], d: 1 },
  { q: 'Which game mode is a bouncing sphere?', a: 'Ball', w: ['Cube', 'Ship', 'Robot'], d: 1 },
  { q: 'Which game mode is a flying saucer?', a: 'UFO', w: ['Cube', 'Ship', 'Spider'], d: 1 },
  { q: 'Which game mode runs on legs?', a: 'Robot', w: ['Cube', 'Ship', 'Wave'], d: 1 },
  { q: 'Which is the default icon mode?', a: 'Cube', w: ['Ship', 'Ball', 'Robot'], d: 1 },
  { q: 'Which portal makes you go faster?', a: 'Speed Portal', w: ['Mirror Portal', 'Mini Portal', 'Dual Portal'], d: 1 },
  { q: 'Which portal makes your icon smaller?', a: 'Mini Portal', w: ['Speed Portal', 'Mirror Portal', 'Dual Portal'], d: 1 },
  { q: 'What is the second official level?', a: 'Back On Track', w: ['Stereo Madness', 'Polargeist', 'Dry Out'], d: 1 },
  { q: 'Which portal flips gravity?', a: 'Gravity Portal', w: ['Speed Portal', 'Mini Portal', 'Dual Portal'], d: 1 },
  { q: 'Which portal lets two icons play at once?', a: 'Dual Portal', w: ['Mirror Portal', 'Mini Portal', 'Speed Portal'], d: 1 },
  { q: 'Which hazard is a spike you must avoid?', a: 'Spike', w: ['Saw Blade', 'Jump Pad', 'Portal'], d: 1 },
  { q: 'Which object launches you upward when you touch it?', a: 'Jump Pad', w: ['Spike', 'Saw Blade', 'Portal'], d: 1 },
  { q: 'Which hazard is a spinning blade?', a: 'Saw Blade', w: ['Spike', 'Jump Pad', 'Mini Portal'], d: 1 },
  // difficulty 2
  { q: 'Which mode teleports between ceiling and floor when you tap?', a: 'Spider', w: ['Robot', 'Ship', 'UFO'], d: 2 },
  { q: 'What is the third official level?', a: 'Polargeist', w: ['Stereo Madness', 'Back On Track', 'Dry Out'], d: 2 },
  { q: 'What is the fourth official level?', a: 'Dry Out', w: ['Stereo Madness', 'Polargeist', 'Base After Base'], d: 2 },
  { q: 'What is the fifth official level?', a: 'Base After Base', w: ['Dry Out', 'Can\'t Let Go', 'Jumper'], d: 2 },
  { q: 'Which orb gives you an extra jump in mid-air?', a: 'Yellow Jump Orb', w: ['Pink Jump Orb', 'Red Jump Orb', 'Green Dash Orb'], d: 2 },
  { q: 'Which portal mirrors the level?', a: 'Mirror Portal', w: ['Speed Portal', 'Mini Portal', 'Dual Portal'], d: 2 },
  { q: 'What do you collect in levels to unlock secret rewards?', a: 'Secret Coins', w: ['Gold Keys', 'Diamonds', 'Stars'], d: 2 },
  { q: 'Which company publishes Geometry Dash?', a: 'RobTop Games', w: ['Riot Games', 'Zobros', 'Hinds Studios'], d: 2 },
  { q: 'Which trigger shakes the screen?', a: 'Shake Trigger', w: ['Pulse Trigger', 'Alpha Trigger', 'Move Trigger'], d: 2 },
  { q: 'Which trigger moves objects?', a: 'Move Trigger', w: ['Color Trigger', 'Alpha Trigger', 'Pulse Trigger'], d: 2 },
  { q: 'Which trigger changes the background color?', a: 'Color Trigger', w: ['Move Trigger', 'Alpha Trigger', 'Pulse Trigger'], d: 2 },
  { q: 'Which orb gives you a dash?', a: 'Green Dash Orb', w: ['Yellow Jump Orb', 'Pink Jump Orb', 'Red Jump Orb'], d: 2 },
  { q: 'Which trigger rotates objects?', a: 'Rotate Trigger', w: ['Shake Trigger', 'Move Trigger', 'Color Trigger'], d: 2 },
  { q: 'Which trigger makes objects follow the player?', a: 'Follow Trigger', w: ['Move Trigger', 'Shake Trigger', 'Pulse Trigger'], d: 2 },
  { q: 'Which portal turns you into a rolling ball?', a: 'Ball Portal', w: ['Ship Portal', 'Wave Portal', 'UFO Portal'], d: 2 },
  { q: 'Which portal turns you into a robot?', a: 'Robot Portal', w: ['Spider Portal', 'Wave Portal', 'UFO Portal'], d: 2 },
  { q: 'Which portal turns you into a spider?', a: 'Spider Portal', w: ['Robot Portal', 'Wave Portal', 'UFO Portal'], d: 2 },
  // difficulty 3
  { q: 'What is the sixth official level?', a: 'Can\'t Let Go', w: ['Base After Base', 'Jumper', 'Time Machine'], d: 3 },
  { q: 'What is the seventh official level?', a: 'Jumper', w: ['Can\'t Let Go', 'Time Machine', 'Cycles'], d: 3 },
  { q: 'In what year was Geometry Dash first released?', a: '2013', w: ['2011', '2014', '2016'], d: 3 },
  { q: 'Which trigger changes an object\'s opacity?', a: 'Alpha Trigger', w: ['Pulse Trigger', 'Toggle Trigger', 'Color Trigger'], d: 3 },
  { q: 'Which trigger makes objects pulse in color?', a: 'Pulse Trigger', w: ['Alpha Trigger', 'Toggle Trigger', 'Move Trigger'], d: 3 },
  { q: 'Which trigger shows or hides groups?', a: 'Toggle Trigger', w: ['Alpha Trigger', 'Pulse Trigger', 'Spawn Trigger'], d: 3 },
  { q: 'Which trigger spawns a group when activated?', a: 'Spawn Trigger', w: ['Toggle Trigger', 'Stop Trigger', 'Pulse Trigger'], d: 3 },
  { q: 'Which trigger stops other effects?', a: 'Stop Trigger', w: ['Spawn Trigger', 'Toggle Trigger', 'Pulse Trigger'], d: 3 },
  { q: 'Which trigger reacts when the player touches it?', a: 'Touch Trigger', w: ['Stop Trigger', 'Spawn Trigger', 'Toggle Trigger'], d: 3 },
  // difficulty 4
  { q: 'Which trigger counts activations instantly?', a: 'Instant Count Trigger', w: ['Spawn Trigger', 'Stop Trigger', 'Random Trigger'], d: 4 },
  { q: 'Which trigger picks one of several groups at random?', a: 'Random Trigger', w: ['Spawn Trigger', 'Stop Trigger', 'Touch Trigger'], d: 4 },
  { q: 'What is RobTop\'s real name?', a: 'Robert Topala', w: ['Robert Johnson', 'Robin Topal', 'Robert Taylor'], d: 4 },
];

const SYMBOLS = [
  ['mana orb', '🟠'], ['star', '⭐'], ['moon', '🌙'], ['spike', '🔺'],
  ['key', '🔑'], ['diamond', '💎'], ['skull', '💀'], ['fire', '🔥'],
];

function makeChallenge(kinds = ['math', 'trivia', 'symbol'], avoid = null) {
  const kind = pick(kinds);

  if (kind === 'math') {
    const x = rand(3, 25);
    const y = rand(3, 25);
    const right = String(x + y);
    const wrong = new Set();
    while (wrong.size < 3) {
      const v = String(x + y + rand(-6, 6));
      if (v !== right) wrong.add(v);
    }
    const options = shuffle([right, ...wrong]);
    return { prompt: `What is **${x} + ${y}**?`, options, answer: options.indexOf(right) };
  }

  if (kind === 'trivia') {
    const t = pick(avoid ? TRIVIA.filter((x) => x !== avoid) : TRIVIA);
    const options = shuffle([t.a, ...shuffle(t.w).slice(0, 3)]);
    return { prompt: t.q, options, answer: options.indexOf(t.a), trivia: true, difficulty: t.d, question: t };
  }

  const [name, emoji] = pick(SYMBOLS);
  const others = shuffle(SYMBOLS.filter(([, e]) => e !== emoji)).slice(0, 3).map(([, e]) => e);
  const options = shuffle([emoji, ...others]);
  return { prompt: `Click the **${name}**`, options, answer: options.indexOf(emoji) };
}

const getStrike = (uid) => q.getStrike.get(uid) ?? { fails: 0, locked_until: 0, streak: 0 };
const saveStrike = (uid, s) => q.upsertStrike.run(uid, s.fails, s.locked_until, s.streak);

function recordFail(uid) {
  const s = getStrike(uid);
  s.fails += 1;
  let lockedUntil = 0;
  if (s.fails >= MAX_FAILS) {
    s.fails = 0;
    lockedUntil = nowSec() + LOCK_SECONDS;
    s.locked_until = lockedUntil;
  }
  saveStrike(uid, s);
  return lockedUntil;
}

const rewardEmbed = (uid, r, notes = []) =>
  embed(
    withNotes(`${r.line} and earned **${fmt(r.amount)}** ${ORB}${r.bonus}`, notes) + `\n\nBalance: **${fmt(getBalance(uid))}** ${ORB}`,
    `${ACTIONS[r.name].emoji} /${r.name}`
  );

// A missed or timed-out quiz breaks the quiz streak.
const breakQuizStreak = (p) => {
  if (p.reward.name === 'quiz') q.setStat.run(p.userId, 'quiz_streak', 0);
};

// Puts a freshly rolled challenge into a pending entry. Quiz questions also set the payout by difficulty.
function applyChallenge(p, ch) {
  p.prompt = ch.prompt;
  p.options = ch.options;
  p.answer = ch.answer;
  p.question = ch.question ?? null;
  p.difficulty = ch.difficulty ?? null;
  p.seconds = ch.trivia ? TRIVIA_SECONDS : CHALLENGE_SECONDS;
  if (p.reward.trivia && ch.difficulty) p.reward.amount = Math.floor(p.reward.base * DIFF_MULT[ch.difficulty]);
}

function armTimer(id, p) {
  p.timer = setTimeout(() => {
    if (!pending.delete(id)) return;
    breakQuizStreak(p);
    const lockedUntil = recordFail(p.userId);
    const extra = lockedUntil ? `\n🔒 Too many fails. Locked <t:${lockedUntil}:R>.` : '';
    p.origin.editReply({ embeds: [embed(`⏰ Too slow, no orbs this time.${extra}`, '🤖 Bot check failed')], components: [] }).catch(() => {});
  }, p.seconds * 1000);
}

const challengeEmbed = (p) => {
  let text = `${p.prompt}\n\n`;
  if (p.reward.trivia && p.difficulty) text += `Difficulty ${'★'.repeat(p.difficulty)} (x${DIFF_MULT[p.difficulty]})\n`;
  text += `Answer within **${p.seconds}s** to claim **${fmt(p.reward.amount)}** ${ORB}`;
  if (p.reward.trivia) text += `\nSkips left: **${p.skipsLeft}**`;
  return embed(text, p.reward.trivia ? '❓ Quiz' : '🤖 Bot check');
};

const challengeRow = (id, p) => {
  const buttons = p.options.map((label, n) =>
    new ButtonBuilder().setCustomId(`ch:${id}:${n}`).setLabel(label).setStyle(ButtonStyle.Secondary)
  );
  if (p.reward.trivia && p.skipsLeft > 0) {
    buttons.push(new ButtonBuilder().setCustomId(`ch:${id}:skip`).setLabel('Skip').setStyle(ButtonStyle.Primary));
  }
  return new ActionRowBuilder().addComponents(buttons);
};

async function sendChallenge(i, reward) {
  const id = Math.random().toString(36).slice(2, 10);
  const p = { userId: i.user.id, origin: i, reward, skipsLeft: reward.trivia ? QUIZ_SKIPS : 0, timer: null };
  applyChallenge(p, makeChallenge(reward.trivia ? ['trivia'] : undefined));
  armTimer(id, p);
  pending.set(id, p);

  return i.reply({ embeds: [challengeEmbed(p)], components: [challengeRow(id, p)] });
}

async function skipQuestion(i, id, p) {
  if (p.skipsLeft <= 0) return i.reply({ content: '❌ No skips left.', flags: EPH });
  p.skipsLeft -= 1;
  clearTimeout(p.timer);
  applyChallenge(p, makeChallenge(['trivia'], p.question));
  armTimer(id, p);
  return i.update({ embeds: [challengeEmbed(p)], components: [challengeRow(id, p)] });
}

async function handleChallengeButton(i) {
  const [tag, id, n] = i.customId.split(':');
  if (tag !== 'ch') return;
  const p = pending.get(id);
  if (!p) return i.reply({ content: '❌ That check expired.', flags: EPH });
  if (p.userId !== i.user.id) return i.reply({ content: "❌ This isn't your check.", flags: EPH });
  if (n === 'skip') return skipQuestion(i, id, p);

  pending.delete(id);
  clearTimeout(p.timer);

  if (Number(n) === p.answer) {
    const s = getStrike(i.user.id);
    s.fails = 0;
    saveStrike(i.user.id, s);
    const granted = mintTx(i.user.id, p.reward.amount);
    if (granted <= 0) {
      return i.update({ embeds: [embed('Correct! But the orb vault is empty right now. Try again later.', '🏦 Vault empty')], components: [] });
    }
    p.reward.amount = granted;
    const notes = afterEarn(i.user.id, i.guildId, earnEvents(p.reward.name, p.difficulty), granted);
    return i.update({ embeds: [rewardEmbed(i.user.id, p.reward, notes)], components: [] });
  }

  breakQuizStreak(p);
  const lockedUntil = recordFail(i.user.id);
  const extra = lockedUntil ? `\n🔒 Too many fails. Locked <t:${lockedUntil}:R>.` : '';
  return i.update({ embeds: [embed(`❌ Wrong answer, no orbs this time.${extra}`, '🤖 Bot check failed')], components: [] });
}

/* ───────────── Earning ───────────── */

async function handleEarn(i, name) {
  const a = ACTIONS[name];
  const now = nowSec();
  const uid = i.user.id;

  const s = getStrike(uid);
  if (now < s.locked_until) return fail(i, `🔒 You're locked out for failing bot checks. Try again <t:${s.locked_until}:R>.`);
  if ([...pending.values()].some((p) => p.userId === uid)) return fail(i, 'Finish your current bot check first.');

  const last = q.getCd.get(uid, name)?.ts ?? 0;
  const readyAt = last + a.cooldown;
  if (now < readyAt) return fail(i, `${a.emoji} You can /${name} again <t:${readyAt}:R>.`);

  let amount = Math.floor(rand(a.min, a.max) * payoutMultiplier());
  for (const [key, item] of Object.entries(SHOP)) {
    const level = item.perk?.action === name ? toolLevel(uid, key) : 0;
    if (level) amount = Math.floor(amount * (1 + rand(item.perk.min, item.perk.max + item.perk.step * (level - 1)) / 100));
  }
  amount = Math.floor(amount * (1 + prestigeBonus(uid) + clanBonus(uid)));
  let bonus = '';
  if (Math.random() < a.bonusChance) {
    amount *= a.bonusMult;
    bonus = `\n✨ **${a.bonusText}** (x${a.bonusMult})`;
  }
  const reward = { name, amount, base: amount, bonus, line: pick(a.lines), trivia: a.trivia };

  s.streak += 1;
  if (a.trivia || Math.random() < CHALLENGE_CHANCE || s.streak >= FORCE_AFTER) {
    s.streak = 0;
    saveStrike(uid, s);
    q.setCd.run(uid, name, now); // cooldown starts now, orbs are paid only if solved
    return sendChallenge(i, reward);
  }

  saveStrike(uid, s);
  const granted = earnTx(uid, name, amount, now);
  if (granted <= 0) return i.reply({ embeds: [embed('The orb vault is empty right now. More orbs are released over time, try again later.', '🏦 Vault empty')] });
  reward.amount = granted;
  const notes = afterEarn(uid, i.guildId, earnEvents(name), granted);
  return i.reply({ embeds: [rewardEmbed(uid, reward, notes)] });
}

async function handleBuy(i) {
  // Role grants can be slow, so acknowledge now to stay inside Discord's 3-second window.
  await i.deferReply({ flags: EPH });
  const key = i.options.getString('item');
  const item = { ...SHOP[key], price: priceOf(key) };
  const uid = i.user.id;
  const roleId = item.roleEnv ? process.env[item.roleEnv] : null;
  if (item.roleEnv && !roleId) return fail(i, `${item.name} isn't set up yet. An admin needs to set \`${item.roleEnv}\`.`);

  if (item.salaryBoost) {
    if (!hasPaidSalary(i.member, i.guildId)) return fail(i, `${item.name} needs a paid salary. Get a role with a /salary payout first.`);
    if (salaryBoost(uid) >= item.salaryBoost) return fail(i, `You already have a salary boost at least this good.`);
  }

  const result = buyTx(uid, key, item.price, nowSec());
  if (result === 'owned') return fail(i, `You already own ${item.name}.`);
  if (result === 'poor') {
    return fail(i, `You need **${fmt(item.price)}** ${ORB} but only have **${fmt(getBalance(uid))}**.`);
  }

  if (roleId) {
    try {
      await i.member.roles.add(roleId);
    } catch (err) {
      console.error('Role grant failed, refunding:', err);
      undoBuyTx(uid, key, item.price);
      return fail(i, "I couldn't give you the role (check my permissions and role order). You were refunded.");
    }
  }
  return i.editReply({
    embeds: [embed(`You bought **${item.name}** for **${fmt(item.price)}** ${ORB}\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '🛒 Purchase complete')],
  });
}

async function handleSalary(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server for that.');
  const sub = i.options.getSubcommand();

  if (sub === 'set') {
    const role = i.options.getRole('role');
    const amount = i.options.getInteger('amount');
    q.setSalary.run(i.guildId, role.id, amount);
    return i.reply({ embeds: [embed(`${role} now earns **${fmt(amount)}** ${ORB} every ${SALARY_INTERVAL_MIN} min.`, '💼 Salary set')] });
  }
  if (sub === 'remove') {
    const role = i.options.getRole('role');
    q.delSalary.run(i.guildId, role.id);
    return i.reply({ embeds: [embed(`Removed the payout for ${role}.`, '💼 Salary removed')] });
  }
  const rows = q.salaries.all(i.guildId);
  const text = rows.length
    ? rows.map((r) => `<@&${r.role_id}> — **${fmt(r.amount)}** ${ORB}`).join('\n')
    : 'No role payouts set. Use `/salary set`.';
  return i.reply({ embeds: [embed(`${text}\n\nPaid every ${SALARY_INTERVAL_MIN} min. Members with several paid roles get the highest one.`, '💼 Role salaries')] });
}

/* ───────────── Daily, tools, levels ───────────── */

async function handleDaily(i) {
  const uid = i.user.id;
  const today = Math.floor(nowSec() / DAY_SECONDS);
  const d = q.getDaily.get(uid);
  if (d && d.last_day >= today) {
    return fail(i, `You already claimed today. Next claim <t:${(today + 1) * DAY_SECONDS}:R>.`);
  }
  const streak = d && d.last_day === today - 1 ? d.streak + 1 : 1;
  const amount = Math.floor((DAILY_BASE + DAILY_STEP * Math.min(streak - 1, DAILY_MAX_STREAK - 1)) * payoutMultiplier());
  const granted = mintTx(uid, amount);
  if (granted <= 0) return i.reply({ embeds: [embed('The orb vault is empty right now. Try again later.', '🏦 Vault empty')] });
  q.setDaily.run(uid, today, streak);
  const notes = [];
  bumpStat(uid, 'daily_streak', streak, notes, 'max');
  afterEarn(uid, i.guildId, ['daily'], granted, notes);
  const note = streak >= DAILY_MAX_STREAK ? ' (max streak bonus)' : '';
  const text = `You claimed **${fmt(granted)}** ${ORB}\nStreak: **${streak}** day${streak === 1 ? '' : 's'}${note}. Miss a day and it resets.`;
  return i.reply({
    embeds: [embed(`${withNotes(text, notes)}\n\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '📅 Daily reward')],
  });
}

async function handleUpgrade(i) {
  const key = i.options.getString('tool');
  const uid = i.user.id;
  const item = SHOP[key];
  const level = toolLevel(uid, key);
  if (!level) return fail(i, `You don't own ${item.name} yet. Buy it with \`/buy\`.`);
  if (level >= MAX_TOOL_LEVEL) return fail(i, `${item.name} is already max level.`);

  const cost = upgradeCost(key, level);
  if (upgradeTx(uid, key, cost, level) === 'poor') {
    return fail(i, `Upgrading to level ${level + 1} costs **${fmt(cost)}** ${ORB} but you only have **${fmt(getBalance(uid))}**.`);
  }
  return i.reply({
    embeds: [embed(`${item.name} is now level **${level + 1}**. Payout bonus: ${toolRange(key, level + 1)}.\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '🔧 Tool upgraded')],
  });
}

async function handleLevel(i) {
  const uid = i.user.id;
  const { xp, prestige } = progressOf(uid);
  const level = levelOf(xp);
  const next = level >= MAX_LEVEL ? 'Max level reached' : `Next level at **${fmt(XP_BASE * level * level)}** XP`;
  return i.reply({
    embeds: [
      embed(
        `Level **${level}** / ${MAX_LEVEL}\nXP: **${fmt(xp)}** (${next})\nPrestige: **${prestige}** / ${MAX_PRESTIGE} (earn payouts +${Math.round(prestige * PRESTIGE_BONUS * 100)}%)\nBadges: **${q.userAchs.all(uid).length}** / ${ACHIEVEMENTS.length} (see \`/achievements\`)`,
        '⭐ Your level'
      ),
    ],
  });
}

async function handlePrestige(i) {
  const uid = i.user.id;
  const { xp, prestige } = progressOf(uid);
  const level = levelOf(xp);
  if (level < MAX_LEVEL) return fail(i, `You need level **${MAX_LEVEL}** to prestige. You're level **${level}**.`);
  if (prestige >= MAX_PRESTIGE) return fail(i, 'You are already at max prestige.');
  q.resetXp.run(uid);
  return i.reply({
    embeds: [embed(`Your level and XP reset. Earn payouts are now +${Math.round((prestige + 1) * PRESTIGE_BONUS * 100)}%. Your orbs and items are kept.`, `🌟 Prestige ${prestige + 1}`)],
  });
}

async function handleAchievements(i) {
  const user = i.options.getUser('user') ?? i.user;
  const owned = new Set(q.userAchs.all(user.id).map((r) => r.key));
  const lines = ACHIEVEMENTS.map((a) => {
    if (owned.has(a.key)) return `✅ **${a.name}** — ${a.desc}`;
    const n = Math.min(q.getStat.get(user.id, a.stat)?.n ?? 0, a.goal);
    return `⬜ **${a.name}** — ${a.desc} (${fmt(n)}/${fmt(a.goal)})`;
  });
  return i.reply({ embeds: [embed(lines.join('\n'), `🏅 ${user.username}: ${owned.size}/${ACHIEVEMENTS.length} achievements`)] });
}

/* ───────────── Clans ───────────── */

const CLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9 '_-]{1,22}[A-Za-z0-9]$/;

function clanInfoEmbed(clan) {
  const members = q.clanMembers.all(clan.id);
  const next = clan.level < CLAN_MAX_LEVEL ? `Next level: **${fmt(clanUpgradeCost(clan.level))}** ${ORB}` : 'Max level';
  const list = members.map((m) => `${m.user_id === clan.owner_id ? '👑' : '•'} <@${m.user_id}> — ${fmt(m.contributed)} ${ORB} deposited`).join('\n');
  return embed(
    `Level **${clan.level}** / ${CLAN_MAX_LEVEL} (earn payouts +${Math.round(clan.level * CLAN_BONUS * 100)}% for every member)\n` +
      `Upgrade fund: **${fmt(clan.treasury)}** ${ORB} · ${next}\n` +
      `Members: **${members.length}** / ${CLAN_MAX_MEMBERS}\n\n${list}`,
    `🏰 ${clan.name}`
  );
}

async function handleClan(i) {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;
  const now = nowSec();
  const mine = q.clanOf.get(uid);
  const ownerOnly = () => (!mine ? "You're not in a clan." : mine.owner_id !== uid ? 'Only the clan owner can do that.' : null);

  if (sub === 'create') {
    const name = i.options.getString('name').trim().replace(/\s+/g, ' ');
    if (!CLAN_NAME.test(name)) return fail(i, 'Clan names are 3-24 characters: letters, numbers, spaces, `-`, `_` or `\'`.');
    const price = clanPrice();
    const result = createClanTx(uid, i.guildId, name, price, now);
    if (result === 'inclan') return fail(i, `You're already in **${mine.name}**. Leave it first.`);
    if (result === 'taken') return fail(i, 'A clan with that name already exists.');
    if (result === 'poor') return fail(i, `Founding a clan costs **${fmt(price)}** ${ORB} but you only have **${fmt(getBalance(uid))}**.`);
    const notes = [];
    bumpStat(uid, 'clan_founded', 1, notes);
    return i.reply({ embeds: [embed(withNotes(`You founded **${name}** for **${fmt(price)}** ${ORB}. Invite players with \`/clan invite\`.`, notes), '🏰 Clan founded')] });
  }

  if (sub === 'invite') {
    const err = ownerOnly();
    if (err) return fail(i, err);
    const target = i.options.getUser('user');
    if (target.bot || target.id === uid) return fail(i, 'Pick another real player.');
    if (q.clanOf.get(target.id)) return fail(i, `${target} is already in a clan.`);
    if (q.clanSize.get(mine.id).n >= CLAN_MAX_MEMBERS) return fail(i, 'Your clan is full.');
    q.addInvite.run(mine.id, target.id, now);
    return i.reply({ content: `${target}, you've been invited to **${mine.name}**. Use \`/clan join name:${mine.name}\` within ${CLAN_INVITE_DAYS} days.` });
  }

  if (sub === 'join') {
    const clan = q.clanByName.get(i.guildId, i.options.getString('name').trim());
    if (!clan) return fail(i, 'No clan has that name.');
    const result = joinClanTx(uid, clan, now);
    if (result === 'inclan') return fail(i, `You're already in **${mine.name}**. Leave it first.`);
    if (result === 'noinvite') return fail(i, `You need an invite from the owner of **${clan.name}**.`);
    if (result === 'full') return fail(i, `**${clan.name}** is full.`);
    return i.reply({ embeds: [embed(`${i.user} joined **${clan.name}**.`, '🏰 New member')] });
  }

  if (sub === 'leave') {
    if (!mine) return fail(i, "You're not in a clan.");
    const r = leaveClanTx(uid, mine);
    const text = {
      left: `You left **${mine.name}**.`,
      transferred: `You left **${mine.name}**. <@${r.owner}> is the new owner.`,
      disbanded: `You left **${mine.name}**. It had no other members, so it was disbanded and its upgrade fund is gone.`,
    }[r.result];
    return i.reply({ embeds: [embed(text, '🏰 Left clan')] });
  }

  if (sub === 'kick') {
    const err = ownerOnly();
    if (err) return fail(i, err);
    const target = i.options.getUser('user');
    if (target.id === uid) return fail(i, 'Use `/clan leave` to leave your own clan.');
    if (q.clanOf.get(target.id)?.id !== mine.id) return fail(i, `${target} isn't in your clan.`);
    q.delMember.run(target.id);
    return i.reply({ embeds: [embed(`${target} was removed from **${mine.name}**.`, '🏰 Member removed')] });
  }

  if (sub === 'deposit') {
    if (!mine) return fail(i, "You're not in a clan.");
    const amount = i.options.getInteger('amount');
    if (!depositTx(uid, mine.id, amount)) return fail(i, `You only have **${fmt(getBalance(uid))}** ${ORB}.`);
    return i.reply({
      embeds: [embed(`${i.user} put **${fmt(amount)}** ${ORB} into **${mine.name}**'s upgrade fund (now **${fmt(mine.treasury + amount)}** ${ORB}).`, '🏰 Deposit')],
    });
  }

  if (sub === 'upgrade') {
    const err = ownerOnly();
    if (err) return fail(i, err);
    if (mine.level >= CLAN_MAX_LEVEL) return fail(i, `**${mine.name}** is already max level.`);
    const cost = clanUpgradeCost(mine.level);
    if (q.clanLevelUp.run({ cost, id: mine.id, max: CLAN_MAX_LEVEL }).changes === 0) {
      return fail(i, `The next level costs **${fmt(cost)}** ${ORB} but the fund only has **${fmt(mine.treasury)}**.`);
    }
    const level = mine.level + 1;
    return i.reply({ embeds: [embed(`**${mine.name}** is now level **${level}**. Every member earns +${Math.round(level * CLAN_BONUS * 100)}% on earn commands.`, '🏰 Clan upgraded')] });
  }

  if (sub === 'info') {
    const name = i.options.getString('name');
    const clan = name ? q.clanByName.get(i.guildId, name.trim()) : mine;
    if (!clan) return fail(i, name ? 'No clan has that name.' : "You're not in a clan. Name one to look it up.");
    return i.reply({ embeds: [clanInfoEmbed(clan)] });
  }

  const rows = q.topClans.all(i.guildId);
  const medals = ['🥇', '🥈', '🥉'];
  const text = rows.length
    ? rows.map((c, n) => `${medals[n] ?? `**${n + 1}.**`} **${c.name}** — level ${c.level}, ${fmt(c.contributed)} ${ORB} deposited, ${q.clanSize.get(c.id).n} members`).join('\n')
    : 'No clans yet. Found one with `/clan create`.';
  return i.reply({ embeds: [embed(text, '🏆 Top clans')] });
}

/* ───────────── Raids ───────────── */

const raidDirty = new Set(); // guilds whose raid message needs an HP refresh
const hpBar = (hp, max) => {
  const full = Math.round((hp / max) * 20);
  return `${'█'.repeat(full)}${'░'.repeat(20 - full)}`;
};

const raidEmbed = (raid) =>
  embed(
    `${hpBar(raid.hp, raid.max_hp)}\nHP: **${fmt(raid.hp)}** / ${fmt(raid.max_hp)}\n\n` +
      `Every earn command, \`/daily\` and drop win hits the boss. Defeat it <t:${raid.ends}:R> to split ` +
      `**${fmt(Math.floor(RAID_POOL * payoutMultiplier()))}** ${ORB} by damage dealt. \`/raid status\` shows the top hitters.`,
    `⚔️ Raid: ${raid.boss}`
  );

async function startRaid(guild, channel) {
  const maxHp = Math.max(RAID_MIN_HP, guild.memberCount * RAID_HP_PER_MEMBER);
  const ends = nowSec() + RAID_HOURS * 3600;
  q.newRaid.run(guild.id, pick(RAID_BOSSES), maxHp, maxHp, ends, channel.id);
  const raid = q.getRaid.get(guild.id);
  const msg = await channel.send({ embeds: [raidEmbed(raid)] });
  q.setRaidMsg.run(msg.id, guild.id);
  return raid;
}

async function raidMessage(raid) {
  if (!raid.message_id) return null;
  const channel = await client.channels.fetch(raid.channel_id).catch(() => null);
  return channel?.messages.fetch(raid.message_id).catch(() => null) ?? null;
}

async function finishRaid(guildId, won) {
  const closed = closeRaidTx(guildId);
  if (!closed) return;
  const { raid, dealers } = closed;
  raidDirty.delete(guildId);
  q.setMeta.run(`raid_next:${guildId}`, String(nowSec() + RAID_GAP_HOURS * 3600));

  let text;
  if (won && dealers.length) {
    const total = dealers.reduce((n, d) => n + d.dmg, 0);
    const pool = Math.floor(RAID_POOL * payoutMultiplier());
    const paid = payoutTx(dealers.map((d) => [d.user_id, Math.floor((pool * d.dmg) / total)]));
    const unlocks = [];
    for (const d of dealers) {
      const notes = [];
      bumpStat(d.user_id, 'raids_won', 1, notes);
      for (const n of notes) unlocks.push(`<@${d.user_id}> ${n}`);
    }
    const top = dealers
      .slice(0, 10)
      .map((d, n) => `**${n + 1}.** <@${d.user_id}> — ${fmt(d.dmg)} dmg, **${fmt(paid.get(d.user_id) ?? 0)}** ${ORB}`)
      .join('\n');
    const rest = dealers.length > 10 ? `\n…and ${dealers.length - 10} more raiders were paid.` : '';
    text = withNotes(`**${raid.boss}** has fallen! The reward was split between **${dealers.length}** raiders:\n\n${top}${rest}`, unlocks);
  } else {
    text = `**${raid.boss}** escaped. Nobody gets the reward this time.`;
  }

  const msg = await raidMessage(raid);
  if (msg) await msg.edit({ embeds: [embed(text, won ? '🏆 Raid won' : '💨 Raid failed')] }).catch(() => {});
  const channel = await client.channels.fetch(raid.channel_id).catch(() => null);
  if (channel && won) await channel.send({ embeds: [embed(`**${raid.boss}** was defeated. See the results above.`, '🏆 Raid won')] }).catch(() => {});
  if (channel && !won) await channel.send({ embeds: [embed(text, '💨 Raid failed')] }).catch(() => {});
}

// Play deals damage to the live raid boss in that server.
earnHooks.push(({ uid, guildId, events, notes }) => {
  const source = events.find((e) => RAID_DAMAGE[e]);
  if (!source || !guildId) return;
  const crit = Math.random() < RAID_CRIT;
  const dmg = RAID_DAMAGE[source] * (crit ? 2 : 1);
  const row = q.hitRaid.get({ dmg, guild: guildId, now: nowSec() });
  if (!row) return; // no live raid
  q.addDamage.run(guildId, uid, dmg);
  bumpStat(uid, 'raid_dmg', dmg, notes);
  raidDirty.add(guildId);
  notes.push(`⚔️ You hit the raid boss for **${dmg}**${crit ? ' (critical!)' : ''}. HP left: **${fmt(row.hp)}**`);
  if (row.hp === 0) finishRaid(guildId, true).catch(console.error);
});

async function raidTick() {
  const now = nowSec();
  for (const guild of client.guilds.cache.values()) {
    const raid = q.getRaid.get(guild.id);
    if (raid) {
      if (raid.ends <= now || raid.hp === 0) await finishRaid(guild.id, raid.hp === 0);
      else if (raidDirty.delete(guild.id)) {
        const msg = await raidMessage(raid);
        if (msg) await msg.edit({ embeds: [raidEmbed(raid)] }).catch(() => {});
      }
      continue;
    }
    if (!EVENT_CHANNEL_ID) continue;
    const key = `raid_next:${guild.id}`;
    const next = Number(q.getMeta.get(key)?.value ?? 0);
    if (!next) {
      q.setMeta.run(key, String(now + 3600)); // first raid an hour after the bot starts
      continue;
    }
    if (now < next) continue;
    const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
    if (channel?.guildId === guild.id) await startRaid(guild, channel);
  }
}

async function handleRaid(i) {
  const sub = i.options.getSubcommand();
  const raid = q.getRaid.get(i.guildId);

  if (sub === 'start') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server for that.');
    if (raid) return fail(i, `**${raid.boss}** is already rampaging.`);
    await i.reply({ content: 'Summoning a raid boss…', flags: EPH });
    await startRaid(i.guild, i.channel);
    return;
  }

  if (!raid) {
    const next = Number(q.getMeta.get(`raid_next:${i.guildId}`)?.value ?? 0);
    const when = EVENT_CHANNEL_ID && next ? ` The next boss appears <t:${next}:R>.` : '';
    return i.reply({ embeds: [embed(`No raid right now.${when}`, '⚔️ Raid')] });
  }
  const dealers = q.raidDamage.all(i.guildId);
  const top = dealers.slice(0, 5).map((d, n) => `**${n + 1}.** <@${d.user_id}> — ${fmt(d.dmg)} dmg`).join('\n') || 'Nobody has attacked yet.';
  const mine = dealers.find((d) => d.user_id === i.user.id)?.dmg ?? 0;
  const e = raidEmbed(raid);
  e.setDescription(`${e.data.description}\n\n**Top hitters**\n${top}\n\nYour damage: **${fmt(mine)}**`);
  return i.reply({ embeds: [e] });
}

/* ───────────── Orb drops ───────────── */

const activeDrops = new Map(); // dropId -> { seq, prize, title, msg, timer }
let nextDropAt = 0;

// Live drop messages are remembered in meta so a restart can close them out.
const saveDropRefs = () =>
  q.setMeta.run('active_drops', JSON.stringify([...activeDrops.values()].map((d) => ({ channelId: DROP_CHANNEL_ID, messageId: d.msg.id }))));

async function expireStaleDrops() {
  const refs = JSON.parse(q.getMeta.get('active_drops')?.value ?? '[]');
  for (const r of refs) {
    try {
      const channel = await client.channels.fetch(r.channelId);
      const msg = await channel.messages.fetch(r.messageId);
      await msg.edit({ embeds: [embed('The bot restarted, so this drop ended.', '⌛ Drop expired')], components: [] });
    } catch (err) {
      console.error('Could not expire stale drop:', err.message);
    }
  }
  q.setMeta.run('active_drops', '[]');
}

async function spawnDrop() {
  const channel = await client.channels.fetch(DROP_CHANNEL_ID);
  const golden = Math.random() < 0.15;
  const seq = Number(q.getMeta.get('drop_seq')?.value ?? 0) + 1;
  q.setMeta.run('drop_seq', String(seq));
  const prize = Math.floor((golden ? 5 : 1) * DROP_BASE * payoutMultiplier());
  const title = golden ? '✨ Golden Orb' : '🟠 Orb Drop';
  const id = Math.random().toString(36).slice(2, 10);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`drop:${id}`).setLabel('Grab it!').setStyle(ButtonStyle.Success)
  );
  const msg = await channel.send({
    embeds: [embed(`First to click wins **${fmt(prize)}** ${ORB}. Expires in ${DROP_EXPIRE_SECONDS / 60} min.`, title)],
    components: [row],
  });
  const timer = setTimeout(() => {
    if (!activeDrops.delete(id)) return;
    saveDropRefs();
    msg.edit({ embeds: [embed('Nobody grabbed it in time.', '⌛ Drop expired')], components: [] }).catch(() => {});
  }, DROP_EXPIRE_SECONDS * 1000);
  activeDrops.set(id, { seq, prize, title, msg, timer });
  saveDropRefs();
}

async function dropTick() {
  if (!DROP_CHANNEL_ID) return;
  const now = nowSec();
  if (!nextDropAt) nextDropAt = now + rand(DROP_MIN_MINUTES, DROP_MAX_MINUTES) * 60;
  if (now < nextDropAt) return;
  nextDropAt = now + rand(DROP_MIN_MINUTES, DROP_MAX_MINUTES) * 60;
  await spawnDrop();
}

async function handleDropButton(i) {
  const id = i.customId.split(':')[1];
  const d = activeDrops.get(id);
  if (!d) return i.reply({ content: '❌ Too late, that drop is gone.', flags: EPH });

  // After a win you sit out the next DROP_WAIT drops.
  const lastSeq = q.getWin.get(i.user.id)?.seq;
  if (lastSeq !== undefined && d.seq - lastSeq <= DROP_WAIT) {
    const wait = DROP_WAIT + 1 - (d.seq - lastSeq);
    return i.reply({ content: `❌ You won recently. Wait **${wait}** more drop${wait === 1 ? '' : 's'} before you can win again.`, flags: EPH });
  }

  activeDrops.delete(id);
  clearTimeout(d.timer);
  saveDropRefs();
  const granted = mintTx(i.user.id, d.prize);
  if (granted <= 0) {
    return i.update({ embeds: [embed('The orb vault is empty, so nobody gets this one.', '🏦 Vault empty')], components: [] });
  }
  q.setWin.run(i.user.id, d.seq);
  const notes = afterEarn(i.user.id, i.guildId, ['drop'], granted);
  return i.update({
    embeds: [embed(`${withNotes(`<@${i.user.id}> grabbed it and earned **${fmt(granted)}** ${ORB}`, notes)}\n\nBalance: **${fmt(getBalance(i.user.id))}** ${ORB}`, `🎉 ${d.title} claimed`)],
    components: [],
  });
}

/* ───────────── Changelog ───────────── */

// Read from GitHub so it works on Railway, where there's no local .git folder.
const CHANGELOG_REPO = process.env.CHANGELOG_REPO || 'TECWiSaRd/Geometry-Droid';
const CHANGELOG_CACHE_MS = 5 * 60 * 1000;
let changelogCache = { at: 0, text: null };

async function handleChangelog(i) {
  await i.deferReply();
  if (Date.now() - changelogCache.at > CHANGELOG_CACHE_MS) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'gd-orbs-bot' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; // needed for private repos
    const res = await fetch(`https://api.github.com/repos/${CHANGELOG_REPO}/commits?per_page=1`, { headers });
    if (!res.ok) return fail(i, `Couldn't fetch the latest commit (GitHub returned ${res.status}).`);
    const [c] = await res.json();
    const [title, ...rest] = c.commit.message.split('\n');
    const body = rest.filter((line) => !line.startsWith('Co-Authored-By:')).join('\n').trim();
    const when = Math.floor(Date.parse(c.commit.author.date) / 1000);
    const text = [
      `**${title}**`,
      body,
      `\`${c.sha.slice(0, 7)}\` by ${c.commit.author.name} · <t:${when}:R>`,
      `[View commit](${c.html_url}) · [Deployments](https://github.com/${CHANGELOG_REPO}/deployments)`,
    ].filter(Boolean).join('\n\n');
    changelogCache = { at: Date.now(), text: text.slice(0, 4000) };
  }
  return i.editReply({ embeds: [embed(changelogCache.text, '📜 Latest update')] });
}

/* ───────────── Client ───────────── */

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.on(Events.InteractionCreate, async (i) => {
  if (i.isButton()) {
    const handler = i.customId.startsWith('drop:') ? handleDropButton : handleChallengeButton;
    return handler(i).catch(console.error);
  }
  if (!i.isChatInputCommand()) return;
  if (!i.inGuild()) return fail(i, 'Use me in a server.');

  try {
    const cmd = i.commandName;
    if (ACTIONS[cmd]) return await handleEarn(i, cmd);

    switch (cmd) {
      case 'balance': {
        const user = i.options.getUser('user') ?? i.user;
        return i.reply({ embeds: [embed(`${user} has **${fmt(getBalance(user.id))}** ${ORB}`, 'Mana Orbs')] });
      }
      case 'pay': {
        const target = i.options.getUser('user');
        const amount = i.options.getInteger('amount');
        if (target.bot || target.id === i.user.id) return fail(i, "Pick another real player.");
        const received = transferTx(i.user.id, target.id, amount);
        if (received === false) return fail(i, `You only have **${fmt(getBalance(i.user.id))}** ${ORB}.`);
        if (received === 0) return fail(i, 'That\'s too small to cover the 10% tax. Send at least 2 orbs.');
        const tax = amount - received;
        return i.reply({ content: `${ORB} ${i.user} paid ${target} **${fmt(received)}** mana orbs (**${fmt(tax)}** tax went back to the vault).` });
      }
      case 'supply': {
        const cap = supplyCap();
        const circ = circulating();
        return i.reply({
          embeds: [
            embed(
              `In circulation: **${fmt(circ)}** ${ORB}\nSupply cap right now: **${fmt(cap)}** ${ORB}\nLeft to earn: **${fmt(Math.max(0, cap - circ))}** ${ORB}\nGrows by about **${fmt(Math.floor(DAILY_ADD))}** ${ORB} per day (target ${fmt(TARGET_SUPPLY)} after ${SUPPLY_DAYS} days).`,
              '🏦 Orb supply'
            ),
          ],
        });
      }
      case 'shop': {
        const lines = Object.entries(SHOP).map(
          ([key, s]) => `**${s.name}** — ${fmt(priceOf(key))} ${ORB}\n${s.desc}`
        );
        return i.reply({ embeds: [embed(lines.join('\n\n') + '\n\nUse `/buy` to purchase.', '🛒 Shop')] });
      }
      case 'buy':
        return await handleBuy(i);
      case 'leaderboard': {
        const rows = q.top.all();
        const medals = ['🥇', '🥈', '🥉'];
        const text = rows.length
          ? rows.map((r, n) => `${medals[n] ?? `**${n + 1}.**`} <@${r.id}> — ${fmt(r.balance)} ${ORB}`).join('\n')
          : 'Nobody has any orbs yet. Try `/work`!';
        return i.reply({ embeds: [embed(text, '🏆 Richest players')] });
      }
      case 'daily':
        return await handleDaily(i);
      case 'upgrade':
        return await handleUpgrade(i);
      case 'changelog':
        return await handleChangelog(i);
      case 'level':
        return await handleLevel(i);
      case 'achievements':
        return await handleAchievements(i);
      case 'clan':
        return await handleClan(i);
      case 'raid':
        return await handleRaid(i);
      case 'prestige':
        return await handlePrestige(i);
      case 'salary':
        return await handleSalary(i);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Something broke. Try again.', flags: EPH };
    if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

/* ───────────── Auto payments ───────────── */

async function salaryTick() {
  const now = nowSec();
  const last = Number(q.getMeta.get('last_salary')?.value ?? 0);
  if (!last) return q.setMeta.run('last_salary', String(now));
  if (now - last < SALARY_INTERVAL_MIN * 60) return;
  q.setMeta.run('last_salary', String(now));

  for (const guild of client.guilds.cache.values()) {
    const rows = q.salaries.all(guild.id);
    if (!rows.length) continue;
    try {
      // Only hit the API when the cache is incomplete.
      const members = guild.members.cache.size >= guild.memberCount ? guild.members.cache : await guild.members.fetch();
      const payouts = [];
      for (const m of members.values()) {
        if (m.user.bot) continue;
        let best = 0;
        for (const r of rows) if (r.amount > best && m.roles.cache.has(r.role_id)) best = r.amount;
        if (best) payouts.push([m.id, Math.floor(best * (1 + salaryBoost(m.id)))]);
      }
      payoutTx(payouts);
      console.log(`Paid salaries to ${payouts.length} members in ${guild.name}`);
    } catch (err) {
      console.error(`Salary payout failed for ${guild.id}:`, err);
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  supplyStart();
  await expireStaleDrops().catch((err) => console.error('Drop cleanup failed:', err.message));
  try {
    // Clear the other scope so commands don't show up twice (global + guild).
    if (GUILD_ID) {
      const guild = await c.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
      await c.application.commands.set([]);
    } else {
      await c.application.commands.set(commands);
    }
    console.log('Slash commands registered');
  } catch (err) {
    console.error('Command registration failed:', err.message);
  }
  setInterval(() => salaryTick().catch(console.error), 60 * 1000);
  setInterval(() => dropTick().catch(console.error), 60 * 1000);
  setInterval(() => raidTick().catch(console.error), 60 * 1000);
});

client.login(TOKEN);
