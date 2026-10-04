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

const payoutTx = db.transaction((payouts) => {
  const total = payouts.reduce((n, [, a]) => n + a, 0);
  const avail = mintable();
  const ratio = total > avail ? avail / total : 1; // share what's left if the vault is short
  for (const [uid, amount] of payouts) {
    const amt = Math.floor(amount * ratio);
    if (amt <= 0) continue;
    q.ensure.run(uid);
    q.add.run(amt, amt, uid);
    q.addXp.run(uid, amt);
  }
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

const rewardEmbed = (uid, r) =>
  embed(
    `${r.line} and earned **${fmt(r.amount)}** ${ORB}${r.bonus}\n\nBalance: **${fmt(getBalance(uid))}** ${ORB}`,
    `${ACTIONS[r.name].emoji} /${r.name}`
  );

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
    return i.update({ embeds: [rewardEmbed(i.user.id, p.reward)], components: [] });
  }

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
  amount = Math.floor(amount * (1 + prestigeBonus(uid)));
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
  return i.reply({ embeds: [rewardEmbed(uid, reward)] });
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
  const note = streak >= DAILY_MAX_STREAK ? ' (max streak bonus)' : '';
  return i.reply({
    embeds: [embed(`You claimed **${fmt(granted)}** ${ORB}\nStreak: **${streak}** day${streak === 1 ? '' : 's'}${note}. Miss a day and it resets.\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '📅 Daily reward')],
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
        `Level **${level}** / ${MAX_LEVEL}\nXP: **${fmt(xp)}** (${next})\nPrestige: **${prestige}** / ${MAX_PRESTIGE} (earn payouts +${Math.round(prestige * PRESTIGE_BONUS * 100)}%)`,
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
  return i.update({
    embeds: [embed(`<@${i.user.id}> grabbed it and earned **${fmt(granted)}** ${ORB}\nBalance: **${fmt(getBalance(i.user.id))}** ${ORB}`, `🎉 ${d.title} claimed`)],
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
      c.html_url,
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
});

client.login(TOKEN);
