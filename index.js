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

console.log('Starting bot…');
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
// Robbery only reaches the wallet; banked orbs are safe. Its costs go to the vault (not to anyone),
// so robbing an alt can't move orbs more cheaply than /pay.
const ROB_COOLDOWN = 60 * 60; // between attempts
const ROB_SUCCESS = 0.4;
const ROB_STEAL = [0.1, 0.25]; // share of the target's wallet taken on success
const ROB_CUT = 0.2; // share of the loot lost while escaping (to the vault)
const ROB_FINE = 0.15; // share of the robber's wallet lost when caught (to the vault)
const ROB_JAIL = 24 * 60 * 60; // getting caught also bans the robber from the bot for this long
const ROB_WINDOW = 60; // seconds anyone has to call the police before the robbery resolves
const POLICE_REWARD = 0.05; // of the robber's orbs, paid by the robber to whoever stops them
const ROB_MIN_TARGET = 1_000; // smallest wallet worth robbing; scales with payouts
const ROB_MIN_ROBBER = 500; // robbers need this much to cover a fine; scales with payouts
const ROB_SHIELD = 3 * 60 * 60; // after being robbed, safe for this long
const BANK_PER_LEVEL = 10_000; // bank space per player level; scales with payouts
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
// Secret Coins: three per earn command, named after official levels. Found at random while earning.
const COIN_SETS = { work: 'Stereo Madness', build: 'Back On Track', fish: 'Polargeist', mine: 'Dry Out', quiz: 'Base After Base' };
const COINS_PER_SET = 3;
const COIN_CHANCE = 0.03; // per paid earn
const COIN_SET_REWARD = 5_000; // for completing a set; scales with payouts
const TOURNEY_JOIN_SECONDS = 60;
const TOURNEY_ROUNDS = 5;
const TOURNEY_ROUND_SECONDS = 30; // same as other trivia (TRIVIA_SECONDS)
const TOURNEY_MIN_PLAYERS = 3;
const TOURNEY_POOL = 30_000; // split between the top 3; scales with payouts
const TOURNEY_SPLIT = [0.5, 0.3, 0.2];
// Weekly server goals rotate each Monday (UTC). Target = per x active players (min 5).
const WEEKLY_GOALS = [
  { stat: 'mine', text: 'Mine', per: 4 },
  { stat: 'quiz', text: 'Answer quizzes correctly', per: 5 },
  { stat: 'fish', text: 'Fish', per: 6 },
  { stat: 'daily', text: 'Claim /daily', per: 3 },
  { stat: 'build', text: 'Build', per: 4 },
  { stat: 'earns', text: 'Get paid from earn commands', per: 20 },
];
const WEEKLY_REWARD = 5_000; // to every contributor when the goal is met; scales with payouts
// Seasons: 30 days each, counted from the bot's first start. Points = orbs earned through play,
// divided by the payout multiplier so later seasons aren't inflated.
const SEASON_DAYS = 30;
const SEASON_TIERS = [500, 1_500, 3_000, 5_000, 8_000, 12_000, 17_000, 23_000, 30_000, 40_000]; // pass tiers
const SEASON_TIER_REWARD = 250; // x tier number; scales with payouts. The full pass adds roughly a third to a season's earnings
const SEASON_PRIZES = [100_000, 50_000, 25_000]; // top 3 at season end; scale with payouts
const SEASON_ROLE_ID = process.env.SEASON_ROLE_ID; // optional: moves to each season's #1
const SEASON_RESETS_PRESTIGE = false; // true wipes everyone's XP and prestige at each season end
const LOTW_REVIEW_CHANNEL_ID = process.env.LOTW_REVIEW_CHANNEL_ID; // optional: where clear proofs go for review
const LOTW_REWARD_PER_STAR = 2_000; // per star for non-demon levels (up to 9★ = 18,000); scales with payouts
// Demons pay by difficulty instead of stars. Base amounts; they scale with payouts.
const LOTW_DEMON_REWARDS = {
  'Easy Demon': 30_000,
  'Medium Demon': 50_000,
  'Hard Demon': 80_000,
  'Insane Demon': 125_000,
  'Extreme Demon': 200_000,
};
// Stocks follow real Geometry Dash stats, refreshed every STOCK_POLL_MINUTES.
// Level stocks follow download momentum (GDBrowser): downloads in the last 24h vs the level's
// average day over up to 7 days. Player stocks follow the player's Demonlist score (Pointercrate).
// These are listed on first start; after that the list lives in the database, players propose
// levels with /stock propose, and moderators approve, add or remove them.
const DEFAULT_STOCKS = {
  BLD: { name: 'Bloodbath', kind: 'level', id: '10565740' },
  SNW: { name: 'Sonic Wave', kind: 'level', id: '26681070' },
  TDL: { name: 'Tidal Wave', kind: 'level', id: '86407629' },
  ACH: { name: 'Acheron', kind: 'level', id: '73667628' },
  ZNK: { name: 'Zoink', kind: 'player', id: '53408' },
  POP: { name: 'wPopoff', kind: 'player', id: '51613' },
};
const STOCK_MAX = 20; // listed stocks at once (each is one GDBrowser request per update)
const STOCK_MIN_DOWNLOADS = 1_000_000; // proposed levels need this many, so a few alts can't move the price
const STOCK_WARMUP_HOURS = 36; // new listings collect data this long before trading opens
const MAX_REVIEW_DMS = 25; // review requests go to at most this many moderators by DM
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID || LOTW_REVIEW_CHANNEL_ID; // where stock proposals go; also clears if LOTW_REVIEW_CHANNEL_ID isn't set
const STOCK_BASE = 1_000; // price at a stock's usual level. Fixed, so holding doesn't ride payout growth for free
const STOCK_RANGE = [0.25, 4]; // price floor and ceiling, as multiples of the base
const STOCK_FEE = 0.02; // on buys and sells; goes back to the vault
const STOCK_POLL_MINUTES = 15;
const STOCK_STALE_MINUTES = 60; // trading pauses on a stock whose data is older than this
const STOCK_NEWS_MOVE = 0.1; // announce moves of 10%+ in one update

// Anti-AFK / anti-bot checks
const CHALLENGE_CHANCE = 0.2; // random chance per earn command
const FORCE_AFTER = 10; // always check after this many earns without one
const CHALLENGE_SECONDS = 10; // time to answer math and "click the orb" checks
const TRIVIA_SECONDS = 30; // trivia (bot checks and /quiz) needs time to read
const QUIZ_SKIPS = 3; // skips per /quiz, each one rerolls the question
const DIFF_MULT = { 1: 0.5, 2: 1, 3: 2, 4: 3 }; // /quiz payout by question difficulty
const MAX_FAILS = 3; // fails before lockout
const LOCK_SECONDS = 60 * 60; // lockout length

const ORB = process.env.ORB_EMOJI || '<:Mana_Orbs:1556341873054843022>';
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
    fixedPrice: true, // doesn't rise with the supply like other items
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
  // Consumables stack in your inventory and are used with /use. Their prices scale with payouts
  // (not slowly like the items above), so they stay worth about the same as the orbs they earn back.
  speed_potion: {
    name: '🧪 Speed Potion',
    desc: 'Use it to halve all your earn cooldowns for 30 minutes. Up to 2 per day.',
    price: 3_000,
    consumable: { kind: 'speed', minutes: 30, daily: 2 },
  },
  hourglass: {
    name: '⏳ Chamber of Time Hourglass',
    desc: 'Use it to reset all your earn cooldowns at once. Up to 3 per day.',
    price: 800,
    consumable: { kind: 'reset', daily: 3 },
  },
  padlock: {
    name: '🛡️ Padlock',
    desc: 'Use it to guard your wallet for 24 hours. The next robbery attempt fails and the robber is fined. Up to 2 per day.',
    price: 1_500,
    consumable: { kind: 'padlock', hours: 24, daily: 2 },
  },
};
const MAX_STACK = 20; // most of one consumable a player can hold

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
  { key: 'champion', name: '🏆 Champion', desc: 'Win a trivia tournament', stat: 'tourney_wins', goal: 1, reward: 3_000 },
  { key: 'team_spirit', name: '🤝 Team Spirit', desc: 'Help complete 3 weekly challenges', stat: 'weekly_done', goal: 3, reward: 3_000 },
  { key: 'season_champ', name: '👑 Season Champion', desc: 'Finish a season in 1st place', stat: 'season_wins', goal: 1, reward: 10_000 },
  { key: 'level_clearer', name: '🎮 Level Clearer', desc: 'Get 5 Level of the Week clears verified', stat: 'lotw', goal: 5, reward: 10_000 },
  { key: 'hero', name: '🚔 Hero', desc: 'Stop 3 robberies by calling the police', stat: 'police_calls', goal: 3, reward: 2_000 },
  { key: 'master_thief', name: '🦹 Master Thief', desc: 'Pull off 10 successful robberies', stat: 'robs', goal: 10, reward: 2_000 },
  { key: 'coin_hunter', name: '🪙 Coin Hunter', desc: 'Find 5 Secret Coins', stat: 'coins', goal: 5, reward: 2_000 },
  { key: 'completionist', name: '🏆 Completionist', desc: 'Find all 15 Secret Coins', stat: 'coins', goal: 15, reward: 50_000 },
];

/* ───────────── Database ───────────── */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
console.log(`Database opened at ${DB_PATH}`);
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
CREATE TABLE IF NOT EXISTS coins (
  user_id TEXT NOT NULL, coin TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, coin)
);
CREATE TABLE IF NOT EXISTS weekly (
  guild_id TEXT NOT NULL, week INTEGER NOT NULL, goal TEXT NOT NULL, target INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, week)
);
CREATE TABLE IF NOT EXISTS weekly_contrib (
  guild_id TEXT NOT NULL, week INTEGER NOT NULL, user_id TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (guild_id, week, user_id)
);
CREATE TABLE IF NOT EXISTS season_points (
  season INTEGER NOT NULL, user_id TEXT NOT NULL, pts INTEGER NOT NULL, tier INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, user_id)
);
CREATE TABLE IF NOT EXISTS lotw (
  guild_id TEXT PRIMARY KEY, level_id TEXT NOT NULL, name TEXT NOT NULL, stars INTEGER NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lotw_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, level_id TEXT NOT NULL, user_id TEXT NOT NULL, stars INTEGER NOT NULL,
  proof TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, reviewer TEXT,
  UNIQUE (guild_id, level_id, user_id)
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL, item TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (user_id, item)
);
CREATE TABLE IF NOT EXISTS buffs (
  user_id TEXT NOT NULL, buff TEXT NOT NULL, until INTEGER NOT NULL,
  PRIMARY KEY (user_id, buff)
);
CREATE TABLE IF NOT EXISTS item_uses (
  user_id TEXT NOT NULL, item TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (user_id, item, day)
);
CREATE TABLE IF NOT EXISTS review_msgs (
  kind TEXT NOT NULL, ref TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY (kind, ref, message_id)
);
CREATE TABLE IF NOT EXISTS stocks (
  sym TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  status TEXT NOT NULL, proposer TEXT, listed_at INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
  UNIQUE (kind, ref_id)
);
CREATE TABLE IF NOT EXISTS stock_samples (sym TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (sym, ts));
CREATE TABLE IF NOT EXISTS stock_prices (sym TEXT NOT NULL, ts INTEGER NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (sym, ts));
CREATE TABLE IF NOT EXISTS holdings (
  user_id TEXT NOT NULL, sym TEXT NOT NULL, shares INTEGER NOT NULL CHECK (shares >= 0), cost INTEGER NOT NULL,
  PRIMARY KEY (user_id, sym)
);
`);

// Databases from before the bank existed need the column added.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'bank')) {
  db.exec('ALTER TABLE users ADD COLUMN bank INTEGER NOT NULL DEFAULT 0 CHECK (bank >= 0)');
}

// Level of the Week rewards are stored per level and per submission (older rows fall back to stars).
for (const [table, column, type] of [
  ['lotw', 'difficulty', 'TEXT'],
  ['lotw', 'reward_base', 'INTEGER'],
  ['lotw_subs', 'reward_base', 'INTEGER'],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const q = {
  ensure: db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)'),
  bal: db.prepare('SELECT balance FROM users WHERE id = ?'),
  add: db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?'),
  sub: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?'),
  refund: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
  top: db.prepare('SELECT id, balance + bank AS total FROM users WHERE balance + bank > 0 ORDER BY total DESC LIMIT 10'),
  getBank: db.prepare('SELECT bank FROM users WHERE id = ?'),
  toBank: db.prepare('UPDATE users SET balance = balance - @n, bank = bank + @n WHERE id = @id AND balance >= @n'),
  fromBank: db.prepare('UPDATE users SET balance = balance + @n, bank = bank - @n WHERE id = @id AND bank >= @n'),
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
  circ: db.prepare('SELECT COALESCE(SUM(balance + bank), 0) AS s FROM users'),
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
  userCoins: db.prepare('SELECT coin FROM coins WHERE user_id = ?'),
  addCoin: db.prepare('INSERT OR IGNORE INTO coins (user_id, coin, ts) VALUES (?, ?, ?)'),
  newWeekly: db.prepare('INSERT OR IGNORE INTO weekly (guild_id, week, goal, target) VALUES (?, ?, ?, ?)'),
  getWeekly: db.prepare('SELECT * FROM weekly WHERE guild_id = ? AND week = ?'),
  bumpWeekly: db.prepare('UPDATE weekly SET progress = progress + 1 WHERE guild_id = ? AND week = ? AND done = 0 RETURNING progress, target'),
  finishWeekly: db.prepare('UPDATE weekly SET done = 1 WHERE guild_id = ? AND week = ? AND done = 0 AND progress >= target'),
  addContrib: db.prepare('INSERT INTO weekly_contrib (guild_id, week, user_id, n) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, week, user_id) DO UPDATE SET n = n + 1'),
  getContrib: db.prepare('SELECT n FROM weekly_contrib WHERE guild_id = ? AND week = ? AND user_id = ?'),
  contribs: db.prepare('SELECT user_id, n FROM weekly_contrib WHERE guild_id = ? AND week = ? ORDER BY n DESC'),
  activePlayers: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM cooldowns WHERE ts > ?'),
  addPts: db.prepare('INSERT INTO season_points (season, user_id, pts) VALUES (?, ?, ?) ON CONFLICT(season, user_id) DO UPDATE SET pts = pts + excluded.pts RETURNING pts, tier'),
  setTier: db.prepare('UPDATE season_points SET tier = ? WHERE season = ? AND user_id = ?'),
  getPts: db.prepare('SELECT pts, tier FROM season_points WHERE season = ? AND user_id = ?'),
  seasonTop: db.prepare('SELECT user_id, pts FROM season_points WHERE season = ? ORDER BY pts DESC, user_id LIMIT 10'),
  seasonRank: db.prepare('SELECT COUNT(*) + 1 AS r FROM season_points WHERE season = ? AND pts > ?'),
  getLotw: db.prepare('SELECT * FROM lotw WHERE guild_id = ?'),
  setLotw: db.prepare('INSERT OR REPLACE INTO lotw (guild_id, level_id, name, stars, ts, difficulty, reward_base) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  delLotw: db.prepare('DELETE FROM lotw WHERE guild_id = ?'),
  // A rejected clear can be resubmitted; pending or approved ones can't.
  submitClear: db.prepare(`INSERT INTO lotw_subs (guild_id, level_id, user_id, stars, proof, status, ts, reward_base) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(guild_id, level_id, user_id) DO UPDATE SET proof = excluded.proof, stars = excluded.stars, reward_base = excluded.reward_base, status = 'pending', ts = excluded.ts, reviewer = NULL
    WHERE lotw_subs.status = 'rejected' RETURNING id`),
  getClear: db.prepare('SELECT status FROM lotw_subs WHERE guild_id = ? AND level_id = ? AND user_id = ?'),
  reviewClear: db.prepare("UPDATE lotw_subs SET status = @status, reviewer = @reviewer WHERE id = @id AND status = 'pending' RETURNING *"),
  clearCount: db.prepare("SELECT COUNT(*) AS n FROM lotw_subs WHERE guild_id = ? AND level_id = ? AND status = 'approved'"),
  subById: db.prepare('SELECT * FROM lotw_subs WHERE id = ?'),
  getQty: db.prepare('SELECT qty FROM inventory WHERE user_id = ? AND item = ?'),
  addQty: db.prepare('INSERT INTO inventory (user_id, item, qty) VALUES (?, ?, ?) ON CONFLICT(user_id, item) DO UPDATE SET qty = qty + excluded.qty'),
  takeQty: db.prepare('UPDATE inventory SET qty = qty - 1 WHERE user_id = ? AND item = ? AND qty > 0'),
  inventory: db.prepare('SELECT item, qty FROM inventory WHERE user_id = ? AND qty > 0'),
  getBuff: db.prepare('SELECT until FROM buffs WHERE user_id = ? AND buff = ?'),
  setBuff: db.prepare('INSERT OR REPLACE INTO buffs (user_id, buff, until) VALUES (?, ?, ?)'),
  getUses: db.prepare('SELECT n FROM item_uses WHERE user_id = ? AND item = ? AND day = ?'),
  addUse: db.prepare('INSERT INTO item_uses (user_id, item, day, n) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, item, day) DO UPDATE SET n = n + 1'),
  addReviewMsg: db.prepare('INSERT OR IGNORE INTO review_msgs (kind, ref, channel_id, message_id) VALUES (?, ?, ?, ?)'),
  reviewMsgs: db.prepare('SELECT channel_id, message_id FROM review_msgs WHERE kind = ? AND ref = ?'),
  delReviewMsgs: db.prepare('DELETE FROM review_msgs WHERE kind = ? AND ref = ?'),
  insertStock: db.prepare('INSERT INTO stocks (sym, name, kind, ref_id, status, proposer, listed_at, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  stockBySym: db.prepare('SELECT * FROM stocks WHERE sym = ?'),
  stockByRef: db.prepare('SELECT * FROM stocks WHERE kind = ? AND ref_id = ?'),
  listedStocks: db.prepare("SELECT * FROM stocks WHERE status = 'listed' ORDER BY listed_at, sym"),
  listedCount: db.prepare("SELECT COUNT(*) AS n FROM stocks WHERE status = 'listed'"),
  pendingBy: db.prepare("SELECT sym FROM stocks WHERE status = 'pending' AND proposer = ?"),
  approveStock: db.prepare("UPDATE stocks SET status = 'listed', listed_at = ? WHERE sym = ? AND status = 'pending'"),
  delStock: db.prepare('DELETE FROM stocks WHERE sym = ?'),
  holdersOf: db.prepare('SELECT user_id, shares FROM holdings WHERE sym = ? AND shares > 0'),
  delHoldings: db.prepare('DELETE FROM holdings WHERE sym = ?'),
  delSamples: db.prepare('DELETE FROM stock_samples WHERE sym = ?'),
  delPrices: db.prepare('DELETE FROM stock_prices WHERE sym = ?'),
  addSample: db.prepare('INSERT OR REPLACE INTO stock_samples (sym, ts, value) VALUES (?, ?, ?)'),
  lastSample: db.prepare('SELECT ts, value FROM stock_samples WHERE sym = ? ORDER BY ts DESC LIMIT 1'),
  sampleBefore: db.prepare('SELECT ts, value FROM stock_samples WHERE sym = ? AND ts <= ? ORDER BY ts DESC LIMIT 1'),
  firstSampleSince: db.prepare('SELECT ts, value FROM stock_samples WHERE sym = ? AND ts >= ? ORDER BY ts LIMIT 1'),
  addPrice: db.prepare('INSERT OR REPLACE INTO stock_prices (sym, ts, price) VALUES (?, ?, ?)'),
  lastPrice: db.prepare('SELECT ts, price FROM stock_prices WHERE sym = ? ORDER BY ts DESC LIMIT 1'),
  priceBefore: db.prepare('SELECT price FROM stock_prices WHERE sym = ? AND ts <= ? ORDER BY ts DESC LIMIT 1'),
  pricesSince: db.prepare('SELECT price FROM stock_prices WHERE sym = ? AND ts >= ? ORDER BY ts'),
  pruneSamples: db.prepare('DELETE FROM stock_samples WHERE ts < ?'),
  prunePrices: db.prepare('DELETE FROM stock_prices WHERE ts < ?'),
  getHolding: db.prepare('SELECT shares, cost FROM holdings WHERE user_id = ? AND sym = ?'),
  addHolding: db.prepare('INSERT INTO holdings (user_id, sym, shares, cost) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, sym) DO UPDATE SET shares = shares + excluded.shares, cost = cost + excluded.cost'),
  setHolding: db.prepare('UPDATE holdings SET shares = ?, cost = ? WHERE user_id = ? AND sym = ?'),
  holdings: db.prepare('SELECT sym, shares, cost FROM holdings WHERE user_id = ? AND shares > 0'),
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
const priceOf = (key) =>
  SHOP[key].fixedPrice ? SHOP[key].price : Math.ceil(SHOP[key].price * (SHOP[key].consumable ? payoutMultiplier() : priceMult()));

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

const buyStackTx = db.transaction((uid, key, total, amount) => {
  if ((q.getQty.get(uid, key)?.qty ?? 0) + amount > MAX_STACK) return 'full';
  q.ensure.run(uid);
  if (getBalance(uid) < total) return 'poor';
  q.sub.run(total, uid);
  q.addQty.run(uid, key, amount);
  return 'ok';
});

// Buying removes orbs from circulation; the fee is included in the cost basis.
const buyStockTx = db.transaction((uid, sym, shares, price) => {
  const cost = Math.ceil(shares * price * (1 + STOCK_FEE));
  q.ensure.run(uid);
  if (getBalance(uid) < cost) return { result: 'poor', cost };
  q.sub.run(cost, uid);
  q.addHolding.run(uid, sym, shares, cost);
  return { result: 'ok', cost };
});

// Selling is paid from the vault like earning, so it can't push circulation past the cap.
// Not counted as earned orbs or XP.
const sellStockTx = db.transaction((uid, sym, shares, price) => {
  const h = q.getHolding.get(uid, sym);
  if (!h || h.shares < shares) return { result: 'short', have: h?.shares ?? 0 };
  const proceeds = Math.floor(shares * price * (1 - STOCK_FEE));
  if (proceeds > mintable()) return { result: 'vault', proceeds };
  const basis = Math.round((h.cost * shares) / h.shares);
  q.setHolding.run(h.shares - shares, h.cost - basis, uid, sym);
  q.ensure.run(uid);
  q.refund.run(proceeds, uid);
  return { result: 'ok', proceeds, basis };
});

// Lists a level, replacing its pending proposal if there is one.
const listPendingTx = db.transaction((pendingSym, sym, name, id, proposer, now) => {
  if (pendingSym) q.delStock.run(pendingSym);
  q.insertStock.run(sym, name, 'level', id, 'listed', proposer, now, now);
});

// Delisting pays every holder at the last price (shared out if the vault is short) and wipes the stock.
const delistTx = db.transaction((sym, price) => {
  const holders = q.holdersOf.all(sym);
  const total = holders.reduce((n, h) => n + h.shares * price, 0);
  const ratio = total > 0 ? Math.min(1, mintable() / total) : 1;
  const paid = [];
  for (const h of holders) {
    const amt = Math.floor(h.shares * price * ratio);
    if (amt > 0) {
      q.ensure.run(h.user_id);
      q.refund.run(amt, h.user_id);
    }
    paid.push([h.user_id, amt]);
  }
  for (const stmt of [q.delHoldings, q.delSamples, q.delPrices, q.delStock]) stmt.run(sym);
  q.setMeta.run(`stock_base:${sym}`, '0');
  return paid;
});

// A successful robbery: the robber keeps the loot minus the escape cut, which goes to the vault.
const robTx = db.transaction((robber, target, pct) => {
  const stolen = Math.floor(getBalance(target) * pct);
  if (stolen <= 0) return null;
  const lost = Math.ceil(stolen * ROB_CUT);
  q.sub.run(stolen, target);
  q.ensure.run(robber);
  q.refund.run(stolen - lost, robber);
  return { stolen, kept: stolen - lost, lost };
});

// Takes orbs from the wallet first, then the bank, so banking mid-robbery can't dodge a fine.
function charge(uid, amount) {
  const fromWallet = Math.min(amount, getBalance(uid));
  if (fromWallet > 0) q.sub.run(fromWallet, uid);
  const fromBank = amount - fromWallet;
  if (fromBank > 0) {
    q.fromBank.run({ n: fromBank, id: uid }); // bank -> wallet, then out
    q.sub.run(fromBank, uid);
  }
}
const holdings = (uid) => getBalance(uid) + (q.getBank.get(uid)?.bank ?? 0);

// A caught robber loses ROB_FINE of everything they hold, to the vault.
const fineTx = db.transaction((uid) => {
  const fine = Math.ceil(holdings(uid) * ROB_FINE);
  if (fine > 0) charge(uid, fine);
  return fine;
});

// Stopped by the police: the usual fine to the vault, plus POLICE_REWARD paid to the caller.
const policeTx = db.transaction((robber, caller) => {
  const total = holdings(robber);
  const fine = Math.ceil(total * ROB_FINE);
  const reward = Math.floor(total * POLICE_REWARD);
  charge(robber, fine + reward);
  if (reward > 0) {
    q.ensure.run(caller);
    q.refund.run(reward, caller);
  }
  return { fine, reward };
});

// Takes one from the inventory if the player has one and hasn't hit today's limit.
const useItemTx = db.transaction((uid, key, day, daily) => {
  if ((q.getQty.get(uid, key)?.qty ?? 0) < 1) return 'none';
  if ((q.getUses.get(uid, key, day)?.n ?? 0) >= daily) return 'limit';
  q.takeQty.run(uid, key);
  q.addUse.run(uid, key, day);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    .setName('help')
    .setDescription('How the bot works')
    .addStringOption((o) =>
      o
        .setName('topic')
        .setDescription('Jump to a topic')
        .addChoices(
          { name: 'Basics', value: 'start' },
          { name: 'Earning', value: 'earning' },
          { name: 'Shop', value: 'shop' },
          { name: 'Progress', value: 'progress' },
          { name: 'Clans', value: 'social' },
          { name: 'Events', value: 'events' },
          { name: 'Stocks', value: 'stocks' },
          { name: 'Robbery', value: 'robbery' },
          { name: 'Admin', value: 'admin' }
        )
    ),
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
    )
    .addIntegerOption((o) => o.setName('amount').setDescription('How many (potions and other consumables only)').setMinValue(1).setMaxValue(MAX_STACK)),
  new SlashCommandBuilder()
    .setName('use')
    .setDescription('Use a potion or other consumable')
    .addStringOption((o) =>
      o
        .setName('item')
        .setDescription('What to use')
        .setRequired(true)
        .addChoices(...Object.entries(SHOP).filter(([, s]) => s.consumable).map(([value, s]) => ({ name: s.name, value })))
    ),
  new SlashCommandBuilder().setName('inventory').setDescription('Your potions, active effects and tools'),
  new SlashCommandBuilder().setName('stocks').setDescription('Stock prices, driven by real Geometry Dash stats'),
  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Trade stocks or look one up')
    .addSubcommand((s) =>
      s
        .setName('buy')
        .setDescription(`Buy shares (${STOCK_FEE * 100}% fee)`)
        .addStringOption((o) => o.setName('symbol').setDescription('Which stock').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('shares').setDescription('How many shares').setRequired(true).setMinValue(1).setMaxValue(1_000_000))
    )
    .addSubcommand((s) =>
      s
        .setName('sell')
        .setDescription(`Sell shares (${STOCK_FEE * 100}% fee)`)
        .addStringOption((o) => o.setName('symbol').setDescription('Which stock').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('shares').setDescription('How many shares (default: all)').setMinValue(1).setMaxValue(1_000_000))
    )
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('What a stock tracks and its recent prices')
        .addStringOption((o) => o.setName('symbol').setDescription('Which stock').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) =>
      s
        .setName('propose')
        .setDescription(`Suggest a level to list (needs ${fmt(STOCK_MIN_DOWNLOADS)}+ downloads; moderators approve)`)
        .addStringOption((o) => o.setName('level_id').setDescription('Geometry Dash level ID').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('List a level right away (Manage Server)')
        .addStringOption((o) => o.setName('level_id').setDescription('Geometry Dash level ID').setRequired(true))
        .addStringOption((o) => o.setName('symbol').setDescription('2-5 letters (default: made from the name)').setMinLength(2).setMaxLength(5))
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delist a stock and pay holders the last price (Manage Server)')
        .addStringOption((o) => o.setName('symbol').setDescription('Which stock').setRequired(true).setAutocomplete(true))
    ),
  new SlashCommandBuilder()
    .setName('rob')
    .setDescription(`Steal from someone's wallet (${ROB_SUCCESS * 100}% chance; caught = fine + ${ROB_JAIL / 3600}h ban)`)
    .addUserOption((o) => o.setName('user').setDescription('Who to rob').setRequired(true)),
  new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Keep orbs safe from robbers')
    .addSubcommand((s) => s.setName('view').setDescription('Your wallet, bank and bank space'))
    .addSubcommand((s) =>
      s.setName('deposit').setDescription('Move orbs into the bank (default: as much as fits)').addIntegerOption((o) => o.setName('amount').setDescription('How many').setMinValue(1))
    )
    .addSubcommand((s) =>
      s.setName('withdraw').setDescription('Move orbs back to your wallet (default: all)').addIntegerOption((o) => o.setName('amount').setDescription('How many').setMinValue(1))
    ),
  new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('Your shares, their value and your profit or loss')
    .addUserOption((o) => o.setName('user').setDescription('Someone else')),
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
    .setName('tournament')
    .setDescription('Start a trivia tournament in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((o) => o.setName('rounds').setDescription(`Number of questions (default ${TOURNEY_ROUNDS})`).setMinValue(3).setMaxValue(10)),
  new SlashCommandBuilder().setName('weekly').setDescription("See this week's server-wide challenge"),
  new SlashCommandBuilder().setName('season').setDescription('Season standings and your season pass'),
  new SlashCommandBuilder()
    .setName('lotw')
    .setDescription('Level of the Week: beat it and send proof for orbs')
    .addSubcommand((s) => s.setName('info').setDescription('See the current Level of the Week'))
    .addSubcommand((s) =>
      s
        .setName('submit')
        .setDescription('Send proof that you beat it')
        .addAttachmentOption((o) => o.setName('proof').setDescription('Screenshot or video of the clear').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Feature a level (Manage Server). Name, stars and difficulty are looked up automatically')
        .addStringOption((o) => o.setName('level_id').setDescription('Geometry Dash level ID').setRequired(true))
        .addStringOption((o) => o.setName('name').setDescription('Override the level name'))
        .addIntegerOption((o) => o.setName('stars').setDescription('Override the star rating (non-demons pay per star)').setMinValue(1).setMaxValue(10))
        .addStringOption((o) =>
          o
            .setName('difficulty')
            .setDescription('Override the demon difficulty (demons pay by difficulty)')
            .addChoices({ name: 'Not a demon', value: 'none' }, ...Object.keys(LOTW_DEMON_REWARDS).map((d) => ({ name: d, value: d })))
        )
    )
    .addSubcommand((s) => s.setName('end').setDescription('Stop featuring the level (Manage Server)')),
  new SlashCommandBuilder()
    .setName('coins')
    .setDescription('See your Secret Coin collection')
    .addUserOption((o) => o.setName('user').setDescription('Someone else')),
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
  const readyAt = last + Math.ceil(a.cooldown * cooldownMult(uid, now));
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
  if (item.consumable) {
    const amount = i.options.getInteger('amount') ?? 1;
    const total = item.price * amount;
    const result = buyStackTx(uid, key, total, amount);
    if (result === 'full') return fail(i, `You can hold up to **${MAX_STACK}** of ${item.name}.`);
    if (result === 'poor') return fail(i, `${amount} × ${item.name} costs **${fmt(total)}** ${ORB} but you only have **${fmt(getBalance(uid))}**.`);
    return i.editReply({
      embeds: [embed(`You bought **${amount} × ${item.name}** for **${fmt(total)}** ${ORB}. Use it with \`/use\`.\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '🛒 Purchase complete')],
    });
  }
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

/* ───────────── Consumables ───────────── */

// A Speed Potion halves every earn cooldown while it lasts.
const cooldownMult = (uid, now) => ((q.getBuff.get(uid, 'speed')?.until ?? 0) > now ? 0.5 : 1);
const usesLeft = (uid, key) => SHOP[key].consumable.daily - (q.getUses.get(uid, key, Math.floor(nowSec() / DAY_SECONDS))?.n ?? 0);

async function handleUse(i) {
  const key = i.options.getString('item');
  const item = SHOP[key];
  const c = item.consumable;
  const uid = i.user.id;
  const now = nowSec();

  // Check that it would do something before using it up.
  if (c.kind === 'speed') {
    const until = q.getBuff.get(uid, 'speed')?.until ?? 0;
    if (until > now) return fail(i, `A Speed Potion is already active until <t:${until}:t>.`);
  }
  if (c.kind === 'padlock') {
    const until = q.getBuff.get(uid, 'padlock')?.until ?? 0;
    if (until > now) return fail(i, `A Padlock is already guarding your wallet until <t:${until}:t>.`);
  }
  if (c.kind === 'reset') {
    const waiting = Object.entries(ACTIONS).some(([name, a]) => now < (q.getCd.get(uid, name)?.ts ?? 0) + Math.ceil(a.cooldown * cooldownMult(uid, now)));
    if (!waiting) return fail(i, 'None of your earn commands are on cooldown, so the Hourglass would be wasted.');
  }

  const result = useItemTx(uid, key, Math.floor(now / DAY_SECONDS), c.daily);
  if (result === 'none') return fail(i, `You don't have a ${item.name}. Buy one with \`/buy\`.`);
  if (result === 'limit') return fail(i, `You've used ${c.daily} today, the daily limit. More <t:${(Math.floor(now / DAY_SECONDS) + 1) * DAY_SECONDS}:R>.`);

  const left = q.getQty.get(uid, key)?.qty ?? 0;
  const footer = `\n\nYou have **${left}** left · **${usesLeft(uid, key)}** more use${usesLeft(uid, key) === 1 ? '' : 's'} today`;
  if (c.kind === 'speed') {
    const until = now + c.minutes * 60;
    q.setBuff.run(uid, 'speed', until);
    return i.reply({ embeds: [embed(`All your earn cooldowns are halved until <t:${until}:t> (<t:${until}:R>).${footer}`, `${item.name} active`)] });
  }
  if (c.kind === 'padlock') {
    const until = now + c.hours * 3600;
    q.setBuff.run(uid, 'padlock', until);
    return i.reply({ embeds: [embed(`Your wallet is guarded until <t:${until}:f>. The next robbery attempt will fail and the robber gets fined.${footer}`, `${item.name} active`)] });
  }
  // Backdate each cooldown just far enough that it's ready now; the timestamps stay recent for activity counts.
  for (const [name, a] of Object.entries(ACTIONS)) {
    if (q.getCd.get(uid, name)) q.setCd.run(uid, name, now - a.cooldown);
  }
  return i.reply({ embeds: [embed(`Time rewinds. Every earn command is ready to use again.${footer}`, `${item.name} used`)] });
}

async function handleInventory(i) {
  const uid = i.user.id;
  const now = nowSec();
  const owned = new Map(q.inventory.all(uid).map((r) => [r.item, r.qty]));
  const potions = Object.entries(SHOP)
    .filter(([, s]) => s.consumable)
    .map(([key, s]) => `**${s.name}** × ${owned.get(key) ?? 0} · ${usesLeft(uid, key)}/${s.consumable.daily} uses left today`)
    .join('\n');
  const until = q.getBuff.get(uid, 'speed')?.until ?? 0;
  const lock = q.getBuff.get(uid, 'padlock')?.until ?? 0;
  const shield = q.getBuff.get(uid, 'rob_shield')?.until ?? 0;
  const effects =
    [
      until > now && `🧪 Speed Potion: cooldowns halved until <t:${until}:t> (<t:${until}:R>)`,
      lock > now && `🛡️ Padlock: wallet guarded until <t:${lock}:t> (<t:${lock}:R>)`,
      shield > now && `🕶️ Lying low after a robbery: safe until <t:${shield}:t> (<t:${shield}:R>)`,
    ]
      .filter(Boolean)
      .join('\n') || 'None';
  const tools = Object.entries(SHOP)
    .filter(([key, s]) => s.perk && toolLevel(uid, key))
    .map(([key, s]) => `**${s.name}** level ${toolLevel(uid, key)} (${toolRange(key, toolLevel(uid, key))} on /${s.perk.action})`)
    .join('\n') || 'None yet. See `/shop`.';
  return i.reply({
    embeds: [embed(`**Consumables**\n${potions}\n\n**Active effects**\n${effects}\n\n**Tools**\n${tools}`, `🎒 ${i.user.username}'s inventory`)],
    flags: EPH,
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

/* ───────────── Secret Coins ───────────── */

const coinName = (action, n) => `${COIN_SETS[action]} Coin ${n}`;

// Each paid earn has a small chance to turn up a coin you're missing from that command's set.
earnHooks.push(({ uid, events, notes }) => {
  const action = events.find((e) => COIN_SETS[e]);
  if (!action || Math.random() >= COIN_CHANCE) return;
  const owned = new Set(q.userCoins.all(uid).map((r) => r.coin));
  const missing = [];
  for (let n = 1; n <= COINS_PER_SET; n++) if (!owned.has(`${action}:${n}`)) missing.push(n);
  if (!missing.length) return;
  const n = pick(missing);
  q.addCoin.run(uid, `${action}:${n}`, nowSec());
  const have = COINS_PER_SET - missing.length + 1;
  notes.push(`🪙 You found a Secret Coin: **${coinName(action, n)}** (${have}/${COINS_PER_SET})`);
  if (have === COINS_PER_SET) {
    const granted = mintTx(uid, Math.floor(COIN_SET_REWARD * payoutMultiplier()));
    notes.push(`✨ **${COIN_SETS[action]}** set complete!${granted ? ` (+${fmt(granted)} ${ORB})` : ''}`);
  }
  bumpStat(uid, 'coins', 1, notes);
});

async function handleCoins(i) {
  const user = i.options.getUser('user') ?? i.user;
  const owned = new Set(q.userCoins.all(user.id).map((r) => r.coin));
  const lines = Object.entries(COIN_SETS).map(([action, level]) => {
    let row = '';
    for (let n = 1; n <= COINS_PER_SET; n++) row += owned.has(`${action}:${n}`) ? '🪙' : '⚫';
    return `${row} **${level}** (found with \`/${action}\`)`;
  });
  const total = Object.keys(COIN_SETS).length * COINS_PER_SET;
  return i.reply({
    embeds: [embed(`${lines.join('\n')}\n\nEvery paid earn has a small chance to turn up a coin you're missing. Complete a set for a bonus.`, `🪙 ${user.username}: ${owned.size}/${total} Secret Coins`)],
  });
}

/* ───────────── Trivia tournaments ───────────── */

const tournaments = new Map(); // guildId -> live tournament (in memory; a restart ends it)

const signupEmbed = (t, closed = false) =>
  embed(
    `${closed ? 'Signups closed.' : `Click **Join** within **${TOURNEY_JOIN_SECONDS}s**.`} ` +
      `**${t.rounds}** rounds, **${TOURNEY_ROUND_SECONDS}s** each. Points for every right answer, more for harder and faster ones.\n` +
      `Top 3 split **${fmt(Math.floor(TOURNEY_POOL * payoutMultiplier()))}** ${ORB}. Needs at least ${TOURNEY_MIN_PLAYERS} players.\n\nPlayers: **${t.players.size}**`,
    '🏁 Trivia tournament'
  );

async function runTournament(t) {
  await sleep(TOURNEY_JOIN_SECONDS * 1000);
  if (t.players.size < TOURNEY_MIN_PLAYERS) {
    tournaments.delete(t.guildId);
    await t.signup.edit({ embeds: [embed(`Only **${t.players.size}** joined, so the tournament was cancelled.`, '🏁 Tournament cancelled')], components: [] }).catch(() => {});
    return;
  }
  t.started = true;
  await t.signup.edit({ embeds: [signupEmbed(t, true)], components: [] }).catch(() => {});

  for (const [n, qn] of shuffle(TRIVIA).slice(0, t.rounds).entries()) {
    const options = shuffle([qn.a, ...qn.w]);
    t.answer = options.indexOf(qn.a);
    t.answers = new Map();
    t.round = n + 1;
    t.roundStart = Date.now();
    const row = new ActionRowBuilder().addComponents(
      options.map((label, k) => new ButtonBuilder().setCustomId(`tn:${t.id}:${t.round}:${k}`).setLabel(label).setStyle(ButtonStyle.Secondary))
    );
    const msg = await t.channel.send({
      embeds: [embed(`${qn.q}\n\nDifficulty ${'★'.repeat(qn.d)} · **${TOURNEY_ROUND_SECONDS}s**`, `🏁 Round ${t.round} / ${t.rounds}`)],
      components: [row],
    });
    await sleep(TOURNEY_ROUND_SECONDS * 1000);
    t.round = 0; // closes the round to late clicks

    const right = [];
    for (const [uid, a] of t.answers) {
      if (a.choice !== t.answer) continue;
      const pts = 100 * qn.d + Math.round(50 * Math.max(0, 1 - a.ms / (TOURNEY_ROUND_SECONDS * 1000)));
      t.scores.set(uid, (t.scores.get(uid) ?? 0) + pts);
      right.push([uid, pts]);
    }
    right.sort((x, y) => y[1] - x[1]);
    const who = right.length ? right.map(([uid, pts]) => `<@${uid}> +${pts}`).join(', ') : 'Nobody got it.';
    await msg.edit({ embeds: [embed(`${qn.q}\n\nAnswer: **${qn.a}**\n${who}`, `🏁 Round ${n + 1} / ${t.rounds}`)], components: [] }).catch(() => {});
    await sleep(3000);
  }

  tournaments.delete(t.guildId);
  const ranked = [...t.scores.entries()].filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1]);
  const pool = Math.floor(TOURNEY_POOL * payoutMultiplier());
  const paid = payoutTx(ranked.slice(0, TOURNEY_SPLIT.length).map(([uid], n) => [uid, Math.floor(pool * TOURNEY_SPLIT[n])]));
  const unlocks = [];
  ranked.slice(0, TOURNEY_SPLIT.length).forEach(([uid], n) => {
    const notes = [];
    if (n === 0) bumpStat(uid, 'tourney_wins', 1, notes);
    afterEarn(uid, t.guildId, ['tournament'], paid.get(uid) ?? 0, notes);
    for (const note of notes) unlocks.push(`<@${uid}> ${note}`);
  });
  const medals = ['🥇', '🥈', '🥉'];
  const table = ranked.length
    ? ranked
        .slice(0, 10)
        .map(([uid, s], n) => `${medals[n] ?? `**${n + 1}.**`} <@${uid}> — ${fmt(s)} pts${paid.get(uid) ? `, **${fmt(paid.get(uid))}** ${ORB}` : ''}`)
        .join('\n')
    : 'Nobody scored, so no prizes this time.';
  await t.channel.send({ embeds: [embed(withNotes(table, unlocks), '🏁 Tournament results')] }).catch(() => {});
}

async function handleTournament(i) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server for that.');
  if (tournaments.has(i.guildId)) return fail(i, 'A tournament is already running.');
  const t = {
    id: Math.random().toString(36).slice(2, 10),
    guildId: i.guildId,
    channel: i.channel,
    rounds: i.options.getInteger('rounds') ?? TOURNEY_ROUNDS,
    players: new Set(),
    scores: new Map(),
    round: 0,
    started: false,
  };
  tournaments.set(i.guildId, t);
  const join = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tn:${t.id}:join`).setLabel('Join').setStyle(ButtonStyle.Success)
  );
  await i.reply({ embeds: [signupEmbed(t)], components: [join] });
  t.signup = await i.fetchReply();
  runTournament(t).catch((err) => {
    console.error('Tournament failed:', err);
    tournaments.delete(t.guildId);
  });
}

async function handleTournamentButton(i) {
  const [, id, round, choice] = i.customId.split(':');
  const t = [...tournaments.values()].find((x) => x.id === id);
  if (!t) return i.reply({ content: '❌ This tournament is over.', flags: EPH });
  const uid = i.user.id;

  if (round === 'join') {
    if (t.started) return i.reply({ content: '❌ Signups are closed.', flags: EPH });
    if (t.players.has(uid)) return i.reply({ content: "You're already in.", flags: EPH });
    t.players.add(uid);
    return i.update({ embeds: [signupEmbed(t)] });
  }

  if (!t.players.has(uid)) return i.reply({ content: "❌ You didn't join this tournament.", flags: EPH });
  if (Number(round) !== t.round) return i.reply({ content: '❌ That round is over.', flags: EPH });
  if (t.answers.has(uid)) return i.reply({ content: '❌ You already answered this round.', flags: EPH });
  t.answers.set(uid, { choice: Number(choice), ms: Date.now() - t.roundStart });
  return i.reply({ content: '🔒 Answer locked in.', flags: EPH });
}

/* ───────────── Weekly challenges ───────────── */

// Weeks start Monday 00:00 UTC (the Unix epoch was a Thursday, hence the +3 days).
const weekIndex = () => Math.floor((nowSec() / DAY_SECONDS + 3) / 7);
const weekEnd = (week) => ((week + 1) * 7 - 3) * DAY_SECONDS;

// The week's goal is created on first use, sized to how many players were active last week.
function currentWeekly(guildId) {
  const week = weekIndex();
  const goal = WEEKLY_GOALS[week % WEEKLY_GOALS.length];
  const active = q.activePlayers.get(nowSec() - 7 * DAY_SECONDS).n;
  q.newWeekly.run(guildId, week, goal.stat, goal.per * Math.max(5, active));
  return q.getWeekly.get(guildId, week);
}

const weeklyGoalText = (w) => `${WEEKLY_GOALS.find((g) => g.stat === w.goal)?.text ?? w.goal} **${fmt(w.target)}** times as a server`;

async function announce(text, title) {
  if (!EVENT_CHANNEL_ID) return;
  const channel = await client.channels.fetch(EVENT_CHANNEL_ID).catch(() => null);
  await channel?.send({ embeds: [embed(text, title)] }).catch(() => {});
}

earnHooks.push(({ uid, guildId, events, notes }) => {
  if (!guildId) return;
  const w = currentWeekly(guildId);
  if (w.done || !events.includes(w.goal)) return;
  q.addContrib.run(guildId, w.week, uid);
  const row = q.bumpWeekly.get(guildId, w.week);
  if (!row || row.progress < row.target) return;
  if (q.finishWeekly.run(guildId, w.week).changes === 0) return; // someone else already finished it

  const helpers = q.contribs.all(guildId, w.week);
  const each = Math.floor(WEEKLY_REWARD * payoutMultiplier());
  payoutTx(helpers.map((c) => [c.user_id, each]));
  const unlocks = [];
  for (const c of helpers) {
    const own = c.user_id === uid ? notes : [];
    bumpStat(c.user_id, 'weekly_done', 1, own);
    if (c.user_id !== uid) for (const n of own) unlocks.push(`<@${c.user_id}> ${n}`);
  }
  notes.push(`🏁 Weekly challenge complete! All **${helpers.length}** helpers get **${fmt(each)}** ${ORB}.`);
  announce(withNotes(`${weeklyGoalText(w)}: done! All **${helpers.length}** players who helped get **${fmt(each)}** ${ORB}.`, unlocks), '🏁 Weekly challenge complete').catch(() => {});
});

async function handleWeekly(i) {
  const w = currentWeekly(i.guildId);
  const mine = q.getContrib.get(i.guildId, w.week, i.user.id)?.n ?? 0;
  const status = w.done
    ? '✅ Done! Everyone who helped was paid.'
    : `${hpBar(Math.min(w.progress, w.target), w.target)}\nProgress: **${fmt(w.progress)}** / ${fmt(w.target)}`;
  return i.reply({
    embeds: [
      embed(
        `${weeklyGoalText(w)}.\n\n${status}\n\nYour contribution: **${fmt(mine)}**\n` +
          `Reward: **${fmt(Math.floor(WEEKLY_REWARD * payoutMultiplier()))}** ${ORB} to everyone who helped. Ends <t:${weekEnd(w.week)}:R>.`,
        '📆 Weekly challenge'
      ),
    ],
  });
}

/* ───────────── Seasons ───────────── */

const SEASON_SECONDS = SEASON_DAYS * DAY_SECONDS;
const seasonIndex = () => Math.floor((nowSec() - supplyStart()) / SEASON_SECONDS) + 1;
const seasonEnd = (season) => supplyStart() + season * SEASON_SECONDS;

// Season points and the pass: every tier you pass pays out right away.
earnHooks.push(({ uid, granted, notes }) => {
  if (granted <= 0) return;
  const season = seasonIndex();
  const row = q.addPts.get(season, uid, Math.max(1, Math.round(granted / payoutMultiplier())));
  let tier = row.tier;
  while (tier < SEASON_TIERS.length && row.pts >= SEASON_TIERS[tier]) {
    tier += 1;
    const got = mintTx(uid, Math.floor(SEASON_TIER_REWARD * tier * payoutMultiplier()));
    notes.push(`🎟️ Season pass tier **${tier}** reached${got ? ` (+${fmt(got)} ${ORB})` : ''}`);
  }
  if (tier !== row.tier) q.setTier.run(tier, season, uid);
});

// Moves the champion role to the winner in every server the bot is in.
async function moveSeasonRole(winnerId) {
  if (!SEASON_ROLE_ID) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = guild.members.cache.size >= guild.memberCount ? guild.members.cache : await guild.members.fetch();
      for (const m of members.values()) {
        if (m.id !== winnerId && m.roles.cache.has(SEASON_ROLE_ID)) await m.roles.remove(SEASON_ROLE_ID);
      }
      await members.get(winnerId)?.roles.add(SEASON_ROLE_ID);
    } catch (err) {
      console.error(`Season role update failed in ${guild.id}:`, err.message);
    }
  }
}

// Settles finished seasons one at a time: prizes for the top 3, the role, and an announcement.
async function seasonTick() {
  const current = seasonIndex();
  const saved = q.getMeta.get('season_done');
  if (!saved) return q.setMeta.run('season_done', String(current - 1));
  const season = Number(saved.value) + 1;
  if (season >= current) return;
  q.setMeta.run('season_done', String(season));

  const top = q.seasonTop.all(season);
  const podium = top.slice(0, SEASON_PRIZES.length);
  const paid = payoutTx(podium.map((r, n) => [r.user_id, Math.floor(SEASON_PRIZES[n] * payoutMultiplier())]));
  const unlocks = [];
  if (podium[0]) {
    const notes = [];
    bumpStat(podium[0].user_id, 'season_wins', 1, notes);
    for (const n of notes) unlocks.push(`<@${podium[0].user_id}> ${n}`);
    await moveSeasonRole(podium[0].user_id);
  }
  if (SEASON_RESETS_PRESTIGE) db.exec('UPDATE progress SET xp = 0, prestige = 0');

  const medals = ['🥇', '🥈', '🥉'];
  const table = top.length
    ? top.map((r, n) => `${medals[n] ?? `**${n + 1}.**`} <@${r.user_id}> — ${fmt(r.pts)} pts${paid.get(r.user_id) ? `, **${fmt(paid.get(r.user_id))}** ${ORB}` : ''}`).join('\n')
    : 'Nobody played this season.';
  const reset = SEASON_RESETS_PRESTIGE ? '\n\nLevels and prestige have been reset for the new season.' : '';
  await announce(withNotes(`${table}${reset}\n\nSeason **${season + 1}** has begun!`, unlocks), `🏁 Season ${season} results`);
}

async function handleSeason(i) {
  const season = seasonIndex();
  const me = q.getPts.get(season, i.user.id) ?? { pts: 0, tier: 0 };
  const next = me.tier < SEASON_TIERS.length ? `next tier at **${fmt(SEASON_TIERS[me.tier])}** pts` : 'pass complete';
  const rank = me.pts ? `#${q.seasonRank.get(season, me.pts).r}` : 'unranked';
  const top = q.seasonTop.all(season).map((r, n) => `**${n + 1}.** <@${r.user_id}> — ${fmt(r.pts)} pts`).join('\n') || 'Nobody has played yet.';
  const prizes = SEASON_PRIZES.map((p) => fmt(Math.floor(p * payoutMultiplier()))).join(' / ');
  return i.reply({
    embeds: [
      embed(
        `Ends <t:${seasonEnd(season)}:R>. Earn season points by playing.\n\n` +
          `Your points: **${fmt(me.pts)}** (${rank})\nSeason pass: tier **${me.tier}** / ${SEASON_TIERS.length}, ${next}\n\n` +
          `**Top players**\n${top}\n\nTop 3 prizes: ${prizes} ${ORB}${SEASON_ROLE_ID ? `, plus <@&${SEASON_ROLE_ID}> for #1` : ''}`,
        `🗓️ Season ${season}`
      ),
    ],
  });
}

/* ───────────── Level of the Week ───────────── */

const lotwBase = (stars, difficulty) => LOTW_DEMON_REWARDS[difficulty] ?? LOTW_REWARD_PER_STAR * stars;
// Rows saved before difficulty rewards existed have no reward_base, so fall back to stars.
const lotwReward = (row) => Math.floor((row.reward_base ?? LOTW_REWARD_PER_STAR * row.stars) * payoutMultiplier());
const lotwLabel = (row) => (LOTW_DEMON_REWARDS[row.difficulty] ? row.difficulty : `${row.stars}★`);
const isMod = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

/* ───────────── Moderator reviews (by DM) ───────────── */

// Review buttons can be clicked in a DM, where Discord sends no server permissions, so look the
// clicker up in the server the request came from.
async function canReview(i, guildId) {
  if (i.inGuild()) return !!isMod(i);
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const member = await guild?.members.fetch(i.user.id).catch(() => null);
  return !!member?.permissions.has(PermissionFlagsBits.ManageGuild);
}

async function moderators(guild) {
  const members = guild.members.cache.size >= guild.memberCount ? guild.members.cache : await guild.members.fetch().catch(() => guild.members.cache);
  return [...members.values()].filter((m) => !m.user.bot && m.permissions.has(PermissionFlagsBits.ManageGuild)).slice(0, MAX_REVIEW_DMS);
}

// Sends a review request to every moderator by DM. `withoutFiles` is retried when an upload fails.
// If no moderator can be reached, it goes to the fallback channel instead. Returns how many were sent.
async function sendForReview(guild, fallbackChannel, kind, ref, payload, withoutFiles) {
  const send = (target) => target.send(payload).catch(() => (withoutFiles ? target.send(withoutFiles) : null)).catch(() => null);
  const sent = [];
  for (const m of await moderators(guild)) {
    const msg = await send(m);
    if (msg) sent.push(msg);
  }
  if (!sent.length && fallbackChannel) {
    const msg = await send(fallbackChannel);
    if (msg) sent.push(msg);
  }
  for (const msg of sent) q.addReviewMsg.run(kind, String(ref), msg.channelId, msg.id);
  return sent.length;
}

// Once one moderator decides, every other copy shows the outcome instead of live buttons.
async function closeReviews(kind, ref, payload, exceptId) {
  for (const r of q.reviewMsgs.all(kind, String(ref))) {
    if (r.message_id === exceptId) continue;
    const channel = await client.channels.fetch(r.channel_id).catch(() => null);
    const msg = await channel?.messages.fetch(r.message_id).catch(() => null);
    await msg?.edit(payload).catch(() => {});
  }
  q.delReviewMsgs.run(kind, String(ref));
}

// Tells a player the result by DM, or in the event channel if their DMs are closed.
async function tellPlayer(userId, text, title) {
  const user = await client.users.fetch(userId).catch(() => null);
  const ok = await user?.send({ embeds: [embed(text, title)] }).then(() => true, () => false);
  if (!ok) await announce(`<@${userId}> ${text}`, title);
}

async function handleLotw(i) {
  const sub = i.options.getSubcommand();
  const level = q.getLotw.get(i.guildId);

  if (sub === 'set') {
    if (!isMod(i)) return fail(i, 'You need Manage Server for that.');
    const id = i.options.getString('level_id').trim();
    if (!/^\d{1,12}$/.test(id)) return fail(i, 'Level IDs are numbers, like `128` or `91398357`.');
    await i.deferReply();
    // Fill in whatever the moderator didn't give from the GD servers.
    const lvl = await fetchJson(`https://gdbrowser.com/api/level/${id}`).catch(() => null);
    const found = lvl && typeof lvl.name === 'string' ? lvl : null;
    const name = (i.options.getString('name')?.trim() || found?.name || '').slice(0, 64);
    const stars = i.options.getInteger('stars') ?? (found?.stars > 0 ? Math.min(10, found.stars) : null);
    const picked = i.options.getString('difficulty');
    const difficulty = picked === 'none' ? null : picked ?? (LOTW_DEMON_REWARDS[found?.difficulty] ? found.difficulty : null);
    if (!name) return fail(i, "I couldn't look that level up on the GD servers. Give its `name` and `stars` (or `difficulty` for a demon).");
    if (!difficulty && !stars) return fail(i, `**${name}** isn't rated. Give a \`stars\` rating or a demon \`difficulty\` to set the reward.`);
    const row = { stars: stars ?? 10, difficulty, reward_base: lotwBase(stars ?? 10, difficulty) };
    q.setLotw.run(i.guildId, id, name, row.stars, nowSec(), difficulty, row.reward_base);
    return i.editReply({
      embeds: [embed(`**${name}** (ID \`${id}\`, ${lotwLabel(row)}) is the new Level of the Week!\nBeat it and send proof with \`/lotw submit\` for **${fmt(lotwReward(row))}** ${ORB}.`, '🎮 Level of the Week')],
    });
  }

  if (sub === 'end') {
    if (!isMod(i)) return fail(i, 'You need Manage Server for that.');
    if (!level) return fail(i, 'There is no Level of the Week right now.');
    q.delLotw.run(i.guildId);
    return i.reply({ embeds: [embed(`**${level.name}** is no longer the Level of the Week. Pending proofs can still be reviewed.`, '🎮 Level of the Week')] });
  }

  if (!level) return fail(i, 'There is no Level of the Week right now. A moderator can set one with `/lotw set`.');

  if (sub === 'info') {
    const clears = q.clearCount.get(i.guildId, level.level_id).n;
    const mine = q.getClear.get(i.guildId, level.level_id, i.user.id)?.status;
    const you = { pending: 'Your proof is waiting for review.', approved: '✅ You have a verified clear.', rejected: 'Your last proof was rejected. You can submit again.' }[mine] ?? "You haven't submitted a clear yet.";
    return i.reply({
      embeds: [
        embed(
          `**${level.name}** · ID \`${level.level_id}\` · ${lotwLabel(level)}\n\nBeat it, then send a screenshot or video with \`/lotw submit\`. ` +
            `A moderator checks it, and a verified clear pays **${fmt(lotwReward(level))}** ${ORB}.\n\nVerified clears: **${clears}**\n${you}`,
          '🎮 Level of the Week'
        ),
      ],
    });
  }

  // submit
  const proof = i.options.getAttachment('proof');
  if (!/^(image|video)\//.test(proof.contentType ?? '')) return fail(i, 'Proof must be a screenshot or a video.');
  const row = q.submitClear.get(i.guildId, level.level_id, i.user.id, level.stars, proof.url, nowSec(), level.reward_base ?? LOTW_REWARD_PER_STAR * level.stars);
  if (!row) {
    const status = q.getClear.get(i.guildId, level.level_id, i.user.id)?.status;
    return fail(i, status === 'approved' ? 'Your clear of this level is already verified.' : 'Your proof is already waiting for review.');
  }
  await i.deferReply({ flags: EPH });

  const reviewId = LOTW_REVIEW_CHANNEL_ID || REVIEW_CHANNEL_ID;
  const fallback = reviewId ? await client.channels.fetch(reviewId).catch(() => null) : i.channel;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lotw:approve:${row.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`lotw:reject:${row.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
  );
  const e = embed(`${i.user} says they beat **${level.name}** (ID \`${level.level_id}\`, ${lotwLabel(level)}).\nReward if approved: **${fmt(lotwReward(level))}** ${ORB}`, '🎮 Clear to review');
  // Re-upload the proof so it doesn't vanish when Discord's attachment link expires; fall back to the link if it's too big.
  const linkOnly = embed(`${e.data.description}\n\nProof: ${proof.url}`, e.data.title);
  const sent = await sendForReview(
    i.guild,
    fallback,
    'lotw',
    row.id,
    { embeds: [e], components: [buttons], files: [{ attachment: proof.url, name: proof.name }] },
    { embeds: [linkOnly], components: [buttons] }
  );
  if (!sent) {
    q.reviewClear.run({ status: 'rejected', reviewer: null, id: row.id }); // frees the slot so they can try again
    return fail(i, "I couldn't reach any moderators or the review channel. Try again later.");
  }
  return i.editReply({ content: '📨 Proof sent to the moderators. You will be paid when it is approved.' });
}

// Review buttons acknowledge the click first: the permission check can need a lookup on Discord,
// and the click has to be answered within 3 seconds.
async function handleLotwButton(i) {
  await i.deferUpdate();
  const deny = (msg) => i.followUp({ content: `❌ ${msg}`, flags: EPH });
  const [, action, id] = i.customId.split(':');
  const pending = q.subById.get(Number(id));
  if (!pending) return deny('That submission no longer exists.');
  if (!(await canReview(i, pending.guild_id))) return deny('Only moderators (Manage Server) can review clears.');
  if (pending.user_id === i.user.id) return deny("You can't review your own clear.");

  const row = q.reviewClear.get({ status: action === 'approve' ? 'approved' : 'rejected', reviewer: i.user.id, id: Number(id) });
  if (!row) return deny('Someone already reviewed this one.');

  if (action !== 'approve') {
    const done = { content: '', embeds: [embed(`<@${row.user_id}>'s clear was rejected by ${i.user}.`, '🎮 Clear rejected')], components: [] };
    await i.editReply(done);
    await closeReviews('lotw', id, done, i.message?.id);
    return tellPlayer(row.user_id, 'Your Level of the Week clear was not accepted. You can send new proof with `/lotw submit`.', '🎮 Clear rejected');
  }
  const granted = mintTx(row.user_id, lotwReward(row));
  const notes = afterEarn(row.user_id, row.guild_id, ['lotw'], granted);
  const done = { content: '', embeds: [embed(`<@${row.user_id}>'s clear was approved by ${i.user}. They earned **${fmt(granted)}** ${ORB}.`, '🎮 Clear verified')], components: [] };
  await i.editReply(done);
  await closeReviews('lotw', id, done, i.message?.id);
  return tellPlayer(row.user_id, withNotes(`Your Level of the Week clear was verified! You earned **${fmt(granted)}** ${ORB}.`, notes), '🎮 Clear verified');
}

/* ───────────── Robbery and the bank ───────────── */

const bankSpace = (uid) => Math.floor(BANK_PER_LEVEL * levelOf(progressOf(uid).xp) * payoutMultiplier());

const robberies = new Map(); // id -> robbery waiting out its police window (in memory)

const jailRobber = (uid, now) => {
  const until = now + ROB_JAIL;
  q.setBuff.run(uid, 'jail', until);
  return `🚔 <@${uid}> is banned from the bot until <t:${until}:f> (<t:${until}:R>).`;
};
const warnTarget = (r, text, components = []) =>
  r.targetUser.send({ embeds: [embed(text, '🦹 Robbery')], components }).catch(() => {});
const policeRow = (id) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`pol:${id}`).setLabel('Call the police').setEmoji('🚨').setStyle(ButtonStyle.Danger));

async function handleRob(i) {
  const target = i.options.getUser('user');
  const uid = i.user.id;
  const now = nowSec();
  if (target.bot || target.id === uid) return fail(i, 'Pick another real player.');

  const last = q.getCd.get(uid, 'rob')?.ts ?? 0;
  if (now < last + ROB_COOLDOWN) return fail(i, `You can try another robbery <t:${last + ROB_COOLDOWN}:R>.`);
  if ([...robberies.values()].some((r) => r.target === target.id)) return fail(i, `Someone is already robbing ${target}.`);
  const shield = q.getBuff.get(target.id, 'rob_shield')?.until ?? 0;
  if (shield > now) return fail(i, `${target} was robbed recently and is lying low until <t:${shield}:R>.`);
  const minTarget = Math.floor(ROB_MIN_TARGET * payoutMultiplier());
  if (getBalance(target.id) < minTarget) return fail(i, `${target} has less than **${fmt(minTarget)}** ${ORB} in their wallet. Not worth the risk.`);
  const minRobber = Math.floor(ROB_MIN_ROBBER * payoutMultiplier());
  if (holdings(uid) < minRobber) return fail(i, `You need at least **${fmt(minRobber)}** ${ORB} to cover the fine if you get caught.`);
  q.setCd.run(uid, 'rob', now);

  const r = { id: Math.random().toString(36).slice(2, 10), robber: uid, target: target.id, targetUser: target, origin: i, tried: new Set(), checks: new Map() };

  if ((q.getBuff.get(target.id, 'padlock')?.until ?? 0) > now) {
    q.setBuff.run(target.id, 'padlock', 0); // used up
    const fine = fineTx(uid);
    warnTarget(r, `${i.user} tried to rob you, but your 🛡️ Padlock stopped them. It's used up now.`);
    return i.reply({
      embeds: [embed(`${i.user} tried to rob ${target}, but a 🛡️ Padlock was guarding their wallet. They were caught and fined **${fmt(fine)}** ${ORB}.\n${jailRobber(uid, now)}`, '🔒 Robbery foiled')],
    });
  }

  robberies.set(r.id, r);
  r.timer = setTimeout(() => finishRobbery(r).catch(console.error), ROB_WINDOW * 1000);
  warnTarget(r, `${i.user} is robbing you right now! Call the police within **${ROB_WINDOW}s**, or move your orbs into \`/bank\`.`, [policeRow(r.id)]);
  return i.reply({
    embeds: [
      embed(
        `${i.user} is robbing ${target}! Anyone can stop it in the next **${ROB_WINDOW}s**: click **Call the police** and pass a quick check to earn **${POLICE_REWARD * 100}%** of the robber's orbs.`,
        '🦹 Robbery in progress'
      ),
    ],
    components: [policeRow(r.id)],
  });
}

// Nobody called the police in time: the robbery succeeds or fails on its own.
async function finishRobbery(r) {
  if (!robberies.delete(r.id)) return; // already stopped
  const now = nowSec();
  let text;
  let title;
  if (Math.random() >= ROB_SUCCESS) {
    const fine = fineTx(r.robber);
    text = `<@${r.robber}> tried to rob <@${r.target}> and got caught! Fined **${fmt(fine)}** ${ORB}.\n${jailRobber(r.robber, now)}`;
    title = '🚨 Caught';
    warnTarget(r, `<@${r.robber}> tried to rob you but got caught.`);
  } else {
    const loot = robTx(r.robber, r.target, ROB_STEAL[0] + Math.random() * (ROB_STEAL[1] - ROB_STEAL[0]));
    if (!loot) {
      text = `<@${r.target}>'s wallet was empty by the time <@${r.robber}> got there.`;
    } else {
      q.setBuff.run(r.target, 'rob_shield', now + ROB_SHIELD);
      const notes = [];
      bumpStat(r.robber, 'robs', 1, notes);
      warnTarget(r, `<@${r.robber}> robbed **${fmt(loot.stolen)}** ${ORB} from your wallet! Keep orbs in \`/bank\` or use a 🛡️ Padlock to stay safe.`);
      text =
        withNotes(`<@${r.robber}> robbed <@${r.target}> and got away with **${fmt(loot.kept)}** ${ORB} (**${fmt(loot.lost)}** dropped while escaping).`, notes) +
        `\n\n<@${r.target}> is lying low for ${ROB_SHIELD / 3600}h.`;
    }
    title = '🦹 Robbery';
  }
  await r.origin.editReply({ embeds: [embed(text, title)], components: [] }).catch(() => {});
}

// "Call the police" opens a private bot check; the first right answer stops the robbery.
async function handlePoliceButton(i) {
  const [, id, choice] = i.customId.split(':');
  const r = robberies.get(id);
  const uid = i.user.id;
  if (!r) return choice === undefined ? i.reply({ content: '❌ Too late, this robbery is already over.', flags: EPH }) : i.update({ content: '❌ Too late, this robbery is already over.', embeds: [], components: [] });
  if (uid === r.robber) return i.reply({ content: "❌ You can't call the police on yourself.", flags: EPH });

  if (choice === undefined) {
    if (r.tried.has(uid)) return i.reply({ content: '❌ You already called the police on this robbery.', flags: EPH });
    r.tried.add(uid);
    const ch = makeChallenge(['math', 'symbol']);
    r.checks.set(uid, { answer: ch.answer, expires: Date.now() + CHALLENGE_SECONDS * 1000 });
    const row = new ActionRowBuilder().addComponents(
      ch.options.map((label, n) => new ButtonBuilder().setCustomId(`pol:${id}:${n}`).setLabel(label).setStyle(ButtonStyle.Secondary))
    );
    return i.reply({ embeds: [embed(`${ch.prompt}\n\nAnswer within **${CHALLENGE_SECONDS}s** to stop the robbery.`, '🚨 Calling the police')], components: [row], flags: EPH });
  }

  const check = r.checks.get(uid);
  if (!check) return i.reply({ content: '❌ Click **Call the police** first.', flags: EPH });
  r.checks.delete(uid);
  if (Date.now() > check.expires) return i.update({ content: '⏰ Too slow. The police hung up.', embeds: [], components: [] });
  if (Number(choice) !== check.answer) return i.update({ content: "❌ Wrong answer. The police didn't believe you.", embeds: [], components: [] });

  // Stopped. Claim the robbery first so the timer (or another caller) can't also settle it.
  if (!robberies.delete(id)) return i.update({ content: '❌ Too late, this robbery is already over.', embeds: [], components: [] });
  clearTimeout(r.timer);
  const now = nowSec();
  const { fine, reward } = policeTx(r.robber, uid);
  const notes = [];
  bumpStat(uid, 'police_calls', 1, notes);
  await i.update({ content: withNotes(`🚔 You stopped the robbery and earned **${fmt(reward)}** ${ORB}!`, notes), embeds: [], components: [] });
  warnTarget(r, `${i.user} called the police and stopped <@${r.robber}> from robbing you.`);
  await r.origin
    .editReply({
      embeds: [
        embed(
          `${i.user} called the police on <@${r.robber}>! The robber was fined **${fmt(fine)}** ${ORB} and paid **${fmt(reward)}** ${ORB} to ${i.user}.\n${jailRobber(r.robber, now)}`,
          '🚔 Robbery stopped'
        ),
      ],
      components: [],
    })
    .catch(() => {});
}

async function handleBank(i) {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;
  q.ensure.run(uid);
  const space = bankSpace(uid);
  const banked = q.getBank.get(uid).bank;
  const wallet = getBalance(uid);
  const summary = () => {
    const b = q.getBank.get(uid).bank;
    return `Wallet: **${fmt(getBalance(uid))}** ${ORB}\nBank: **${fmt(b)}** / ${fmt(space)} ${ORB}`;
  };

  if (sub === 'deposit') {
    const room = Math.max(0, space - banked);
    const asked = Math.min(i.options.getInteger('amount') ?? wallet, wallet);
    if (asked <= 0) return fail(i, 'Your wallet is empty.');
    if (room <= 0) return fail(i, `Your bank is full (${fmt(banked)} / ${fmt(space)}). It grows as you level up.`);
    const n = Math.min(asked, room);
    q.toBank.run({ n, id: uid });
    const capped = n < asked ? `\nOnly **${fmt(n)}** fit. Your bank grows as you level up.` : '';
    return i.reply({ embeds: [embed(`Deposited **${fmt(n)}** ${ORB}. Banked orbs can't be stolen.${capped}\n\n${summary()}`, '🏦 Bank')], flags: EPH });
  }

  if (sub === 'withdraw') {
    const n = Math.min(i.options.getInteger('amount') ?? banked, banked);
    if (n <= 0) return fail(i, 'Your bank is empty.');
    q.fromBank.run({ n, id: uid });
    return i.reply({ embeds: [embed(`Withdrew **${fmt(n)}** ${ORB}. Orbs in your wallet can be robbed.\n\n${summary()}`, '🏦 Bank')], flags: EPH });
  }

  return i.reply({
    embeds: [embed(`${summary()}\n\nBanked orbs can't be stolen. Your bank holds **${fmt(BANK_PER_LEVEL)}** per level (scaled with payouts), so it grows as you level up. Spending and \`/pay\` use your wallet.`, '🏦 Bank')],
    flags: EPH,
  });
}

/* ───────────── Stocks ───────────── */

// Seed the starting stocks once; after that moderators manage the list.
if (!q.getMeta.get('stocks_seeded')) {
  for (const [sym, x] of Object.entries(DEFAULT_STOCKS)) {
    if (!q.stockBySym.get(sym)) q.insertStock.run(sym, x.name, x.kind, x.id, 'listed', null, 0, nowSec());
  }
  q.setMeta.run('stocks_seeded', '1');
}

const findStock = (sym) => (sym ? q.stockBySym.get(sym.trim().toUpperCase()) : undefined);
const opensAt = (st) => st.listed_at + STOCK_WARMUP_HOURS * 3600;

// Ticker from the level name: initials for several words, else the first letter plus consonants.
function makeSymbol(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let sym = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : '';
  if (sym.length < 3) {
    const flat = words.join('') || 'LVL';
    sym = (flat[0] + flat.slice(1).replace(/[AEIOU]/g, '')).replace(/(.)\1+/g, '$1');
    if (sym.length < 3) sym += flat.slice(1);
    sym = sym.slice(0, 3);
  }
  if (!q.stockBySym.get(sym)) return sym;
  for (let n = 2; n < 100; n++) if (!q.stockBySym.get(`${sym.slice(0, 3)}${n}`)) return `${sym.slice(0, 3)}${n}`;
  return `L${Date.now() % 10000}`;
}

async function stockAutocomplete(i) {
  const typed = i.options.getFocused().toUpperCase();
  const matches = q.listedStocks
    .all()
    .filter((st) => st.sym.includes(typed) || st.name.toUpperCase().includes(typed))
    .slice(0, 25)
    .map((st) => ({ name: `${st.sym} · ${st.name}`, value: st.sym }));
  return i.respond(matches);
}

// Looks a level up on GDBrowser and checks it can be listed.
// `allowPending` lets moderators list a level that is still waiting for approval.
async function checkLevel(id, { allowPending = false } = {}) {
  if (!/^\d{1,12}$/.test(id)) return { error: 'Level IDs are numbers, like \`10565740\`.' };
  const existing = q.stockByRef.get('level', id);
  if (existing && !(allowPending && existing.status === 'pending')) return { error: `That level is already ${existing.status === 'pending' ? 'waiting for approval' : `listed as **${existing.sym}**`}.` };
  if (q.listedCount.get().n >= STOCK_MAX) return { error: `The market is full (${STOCK_MAX} stocks). A moderator has to remove one first.` };
  const lvl = await fetchJson(`https://gdbrowser.com/api/level/${id}`).catch(() => null);
  if (!lvl || typeof lvl.downloads !== 'number') return { error: "I couldn't find that level on the Geometry Dash servers." };
  if (lvl.downloads < STOCK_MIN_DOWNLOADS) {
    return { error: `**${lvl.name}** has ${fmt(lvl.downloads)} downloads. Listed levels need at least **${fmt(STOCK_MIN_DOWNLOADS)}**, so a few extra downloads can't move the price.` };
  }
  return { lvl };
}

async function announceListing(st) {
  await announce(`**${st.sym}** (${st.name}) is now listed. It collects download data first, and trading opens <t:${opensAt(st)}:R>.`, '🔔 New stock');
}

async function handleStockButton(i) {
  await i.deferUpdate(); // see handleLotwButton
  const deny = (msg) => i.followUp({ content: `❌ ${msg}`, flags: EPH });
  const [, action, sym, guildId] = i.customId.split(':');
  if (!(await canReview(i, guildId))) return deny('Only moderators (Manage Server) can review listings.');
  const st = q.stockBySym.get(sym);
  if (!st || st.status !== 'pending') return deny('Someone already reviewed this one.');
  if (st.proposer === i.user.id) return deny("You can't review your own proposal.");

  if (action === 'reject') {
    q.delStock.run(sym);
    const done = { content: '', embeds: [embed(`<@${st.proposer}>'s proposal for **${st.name}** was rejected by ${i.user}.`, '📈 Listing rejected')], components: [] };
    await i.editReply(done);
    await closeReviews('stock', sym, done, i.message?.id);
    return tellPlayer(st.proposer, `Your proposal to list **${st.name}** was not accepted.`, '📈 Listing rejected');
  }
  if (q.listedCount.get().n >= STOCK_MAX) return deny(`The market is full (${STOCK_MAX}). Remove a stock with \`/stock remove\` first.`);
  if (q.approveStock.run(nowSec(), sym).changes === 0) return deny('Someone already reviewed this one.');
  const listed = q.stockBySym.get(sym);
  announceListing(listed).catch(() => {});
  const done = { content: '', embeds: [embed(`**${sym}** (${st.name}) was approved by ${i.user}. Trading opens <t:${opensAt(listed)}:R>.`, '📈 Listing approved')], components: [] };
  await i.editReply(done);
  await closeReviews('stock', sym, done, i.message?.id);
  return tellPlayer(st.proposer, `Your proposal was approved! **${sym}** (${st.name}) opens for trading <t:${opensAt(listed)}:R>.`, '📈 Listing approved');
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'gd-orbs-bot (Discord economy bot)' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

const clampRatio = (r) => Math.min(STOCK_RANGE[1], Math.max(STOCK_RANGE[0], Number.isFinite(r) ? r : 1));

// Level stocks: downloads in the last 24h vs the level's average day. Until there's enough
// history for a real average (36h+), the stock sits at its base price.
function levelRatio(sym, now) {
  const latest = q.lastSample.get(sym);
  const dayAgo = q.sampleBefore.get(sym, now - DAY_SECONDS);
  const oldest = q.firstSampleSince.get(sym, now - 7 * DAY_SECONDS);
  if (!latest || !dayAgo || !oldest) return 1;
  const span = (latest.ts - oldest.ts) / DAY_SECONDS;
  if (span < 1.5) return 1;
  const recent = (latest.value - dayAgo.value) / ((latest.ts - dayAgo.ts) / DAY_SECONDS);
  const usual = (latest.value - oldest.value) / span;
  return usual > 0 ? recent / usual : 1;
}

// Player stocks: score relative to the score when the bot first saw it.
function playerRatio(sym, score) {
  const key = `stock_base:${sym}`;
  const base = Number(q.getMeta.get(key)?.value ?? 0);
  if (!base) {
    q.setMeta.run(key, String(score));
    return 1;
  }
  return score / base;
}

// Pulls fresh stats, records prices and announces big moves. A failed source just leaves that
// stock's price unchanged (and paused once it goes stale).
async function stockTick() {
  const now = nowSec();
  const list = q.listedStocks.all();
  const anyPlayers = list.some((x) => x.kind === 'player');
  const ranking = anyPlayers ? await fetchJson('https://pointercrate.com/api/v1/players/ranking/?limit=100').catch((err) => {
    console.error('Demonlist fetch failed:', err.message);
    return null;
  }) : null;

  const moves = [];
  for (const x of list) {
    const sym = x.sym;
    try {
      const value = x.kind === 'level' ? (await fetchJson(`https://gdbrowser.com/api/level/${x.ref_id}`)).downloads : ranking?.find((p) => String(p.id) === x.ref_id)?.score;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('no data');
      q.addSample.run(sym, now, value);
      const ratio = x.kind === 'level' ? levelRatio(sym, now) : playerRatio(sym, value);
      const price = Math.round(STOCK_BASE * clampRatio(ratio));
      const prev = q.lastPrice.get(sym)?.price;
      q.addPrice.run(sym, now, price);
      if (prev && Math.abs(price - prev) / prev >= STOCK_NEWS_MOVE) moves.push({ sym, x, prev, price });
    } catch (err) {
      console.error(`Stock ${sym} update failed:`, err.message);
    }
  }
  q.pruneSamples.run(now - 8 * DAY_SECONDS);
  q.prunePrices.run(now - 8 * DAY_SECONDS);

  if (moves.length) {
    const lines = moves.map(({ sym, x, prev, price }) => {
      const pct = Math.round(((price - prev) / prev) * 100);
      const why = x.kind === 'level' ? `${x.name} is being played ${pct > 0 ? 'more' : 'less'} than usual` : `${x.name}'s Demonlist score ${pct > 0 ? 'rose' : 'fell'}`;
      return `${pct > 0 ? '📈' : '📉'} **${sym}** ${pct > 0 ? '+' : ''}${pct}% (${fmt(prev)} → ${fmt(price)} ${ORB}): ${why}`;
    });
    await announce(lines.join('\n'), '📰 Market news');
  }
}

// Current price, or null while the data is stale (trading pauses).
function livePrice(sym) {
  const row = q.lastPrice.get(sym);
  if (!row || nowSec() - row.ts > STOCK_STALE_MINUTES * 60) return null;
  return row.price;
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(sym, since) {
  const prices = q.pricesSince.all(sym, since).map((r) => r.price);
  if (prices.length < 2) return '';
  const step = Math.max(1, Math.floor(prices.length / 16));
  const pts = prices.filter((_, n) => n % step === 0).slice(-16);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  return pts.map((p) => SPARK[hi === lo ? 3 : Math.round(((p - lo) / (hi - lo)) * 7)]).join('');
}

function dayChange(sym, price) {
  const old = q.priceBefore.get(sym, nowSec() - DAY_SECONDS)?.price;
  if (!old) return '';
  const pct = ((price - old) / old) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

async function handleStocks(i) {
  const now = nowSec();
  const lines = q.listedStocks.all().map((x) => {
    const sym = x.sym;
    const last = q.lastPrice.get(sym);
    if (now < opensAt(x)) return `**${sym}** ${x.name} — 🕒 new listing, trading opens <t:${opensAt(x)}:R>`;
    if (!last) return `**${sym}** ${x.name} — waiting for data`;
    const live = livePrice(sym);
    const change = dayChange(sym, last.price);
    return `**${sym}** ${x.name} — **${fmt(last.price)}** ${ORB} ${change ? `(${change} 24h)` : ''} ${sparkline(sym, nowSec() - DAY_SECONDS)}${live ? '' : ' ⏸️ paused'}`;
  });
  return i.reply({
    embeds: [embed(`${lines.join('\n')}\n\nPrices follow real GD stats and update every ${STOCK_POLL_MINUTES} min. \`/stock info\` explains each one, and \`/stock propose\` suggests a new level.`, '📈 Stock market')],
  });
}

async function handleStock(i) {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;

  if (sub === 'propose' || sub === 'add') {
    if (sub === 'add' && !isMod(i)) return fail(i, 'You need Manage Server for that. Use \`/stock propose\` instead.');
    if (sub === 'propose' && q.pendingBy.get(uid)) return fail(i, 'You already have a proposal waiting for review.');
    const id = i.options.getString('level_id').trim();
    // A moderator adding a level that's waiting for approval lists it straight away.
    const proposal = sub === 'add' ? q.stockByRef.get('level', id) : null;
    const pending = proposal?.status === 'pending' ? proposal : null;
    const custom = i.options.getString('symbol')?.trim().toUpperCase() ?? null;
    if (custom && !/^[A-Z][A-Z0-9]{1,4}$/.test(custom)) return fail(i, 'Symbols are 2-5 letters or numbers, starting with a letter.');
    if (custom && custom !== pending?.sym && q.stockBySym.get(custom)) return fail(i, `**${custom}** is already taken.`);
    await i.deferReply({ flags: EPH });
    const { lvl, error } = await checkLevel(id, { allowPending: sub === 'add' });
    if (error) return fail(i, error);
    const sym = custom ?? pending?.sym ?? makeSymbol(lvl.name);
    const name = String(lvl.name).slice(0, 40);
    const now = nowSec();

    if (sub === 'add') {
      listPendingTx(pending?.sym, sym, name, id, pending?.proposer ?? uid, now);
      const st = q.stockBySym.get(sym);
      await announceListing(st);
      if (pending) {
        const done = { content: '', embeds: [embed(`**${sym}** (${name}) was added by ${i.user} with \`/stock add\`. Trading opens <t:${opensAt(st)}:R>.`, '📈 Listing approved')], components: [] };
        await closeReviews('stock', pending.sym, done);
        if (pending.proposer !== uid) await tellPlayer(pending.proposer, `Your proposal was approved! **${sym}** (${name}) opens for trading <t:${opensAt(st)}:R>.`, '📈 Listing approved');
      }
      const was = pending ? ` It was waiting for approval (proposed by <@${pending.proposer}>), so the review is closed.` : '';
      return i.editReply({ content: `📈 Listed **${sym}** (${name}). Trading opens <t:${opensAt(st)}:R>.${was}` });
    }

    q.insertStock.run(sym, name, 'level', id, 'pending', uid, 0, now);
    const fallback = REVIEW_CHANNEL_ID ? await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null) : i.channel;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`stk:approve:${sym}:${i.guildId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`stk:reject:${sym}:${i.guildId}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
    );
    const posted = await sendForReview(i.guild, fallback, 'stock', sym, {
      embeds: [
        embed(
          `${i.user} wants to list **${name}** by ${lvl.author} (ID \`${id}\`) as **${sym}**.\n` +
            `Downloads: **${fmt(lvl.downloads)}** · Likes: **${fmt(lvl.likes ?? 0)}** · ${lvl.difficulty ?? 'Unknown'}\n\n` +
            `If approved, it collects data for ${STOCK_WARMUP_HOURS}h before trading opens. Moderators can pick their own symbol with \`/stock add\` instead.`,
          '📈 Stock proposal'
        ),
      ],
      components: [row],
    });
    if (!posted) {
      q.delStock.run(sym);
      return fail(i, "I couldn't reach any moderators or the review channel. Try again later.");
    }
    return i.editReply({ content: `📨 Proposed **${name}** as **${sym}**. A moderator will review it.` });
  }

  const x = findStock(i.options.getString('symbol'));
  if (!x || x.status !== 'listed') return fail(i, "That stock isn't listed. See \`/stocks\`.");
  const sym = x.sym;

  if (sub === 'remove') {
    if (!isMod(i)) return fail(i, 'You need Manage Server for that.');
    const last = q.lastPrice.get(sym)?.price ?? STOCK_BASE;
    const paid = delistTx(sym, last);
    const total = paid.reduce((n, [, a]) => n + a, 0);
    const text = paid.length
      ? `**${sym}** (${x.name}) was delisted. **${paid.length}** holder${paid.length === 1 ? ' was' : 's were'} paid **${fmt(total)}** ${ORB} in total at **${fmt(last)}** per share.`
      : `**${sym}** (${x.name}) was delisted. Nobody held any shares.`;
    announce(text, '🔕 Stock delisted').catch(() => {});
    return i.reply({ embeds: [embed(text, '🔕 Stock delisted')] });
  }

  if (sub === 'info') {
    const last = q.lastPrice.get(sym);
    const sample = q.lastSample.get(sym);
    let detail;
    if (x.kind === 'level') {
      const dayAgo = q.sampleBefore.get(sym, nowSec() - DAY_SECONDS);
      const recent = sample && dayAgo ? `\nDownloads in the last 24h: **${fmt(Math.round(sample.value - dayAgo.value))}**` : '\nBuilding up 24h of download history.';
      detail = `Tracks how much **${x.name}** (level ID \`${x.ref_id}\`) is being played: downloads in the last 24h vs its average day.\nTotal downloads: **${sample ? fmt(Math.round(sample.value)) : '?'}**${recent}`;
    } else {
      detail = `Tracks **${x.name}**'s Demonlist score on Pointercrate.\nCurrent score: **${sample ? sample.value.toFixed(2) : '?'}**`;
    }
    const price = last ? `**${fmt(last.price)}** ${ORB} ${dayChange(sym, last.price) ? `(${dayChange(sym, last.price)} 24h)` : ''}` : 'waiting for data';
    const week = sparkline(sym, nowSec() - 7 * DAY_SECONDS);
    const paused = last && !livePrice(sym) ? '\n⏸️ Trading is paused until fresh data arrives.' : '';
    return i.reply({ embeds: [embed(`${detail}\n\nPrice: ${price}${week ? `\n7 days: ${week}` : ''}${paused}`, `📈 ${sym} · ${x.name}`)] });
  }

  if (nowSec() < opensAt(x)) return fail(i, `**${sym}** is a new listing. Trading opens <t:${opensAt(x)}:R>, once it has enough download history.`);
  const price = livePrice(sym);
  if (!price) return fail(i, `Trading on **${sym}** is paused until fresh data arrives. Try again soon.`);

  if (sub === 'buy') {
    const shares = i.options.getInteger('shares');
    const r = buyStockTx(uid, sym, shares, price);
    if (r.result === 'poor') return fail(i, `${fmt(shares)} ${sym} at ${fmt(price)} costs **${fmt(r.cost)}** ${ORB} with the fee, but you have **${fmt(getBalance(uid))}**.`);
    return i.reply({
      embeds: [embed(`You bought **${fmt(shares)} ${sym}** at **${fmt(price)}** ${ORB} for **${fmt(r.cost)}** ${ORB} (fee included).\nBalance: **${fmt(getBalance(uid))}** ${ORB}`, '📈 Bought')],
    });
  }

  const have = q.getHolding.get(uid, sym)?.shares ?? 0;
  const shares = i.options.getInteger('shares') ?? have;
  if (!have) return fail(i, `You don't own any ${sym}.`);
  const r = sellStockTx(uid, sym, shares, price);
  if (r.result === 'short') return fail(i, `You only have **${fmt(r.have)}** ${sym}.`);
  if (r.result === 'vault') return fail(i, `The orb vault can't cover **${fmt(r.proceeds)}** ${ORB} right now. Try again later or sell fewer shares.`);
  const pl = r.proceeds - r.basis;
  return i.reply({
    embeds: [
      embed(
        `You sold **${fmt(shares)} ${sym}** at **${fmt(price)}** ${ORB} for **${fmt(r.proceeds)}** ${ORB} (fee included).\n` +
          `${pl >= 0 ? 'Profit' : 'Loss'}: **${pl >= 0 ? '+' : '-'}${fmt(Math.abs(pl))}** ${ORB}\nBalance: **${fmt(getBalance(uid))}** ${ORB}`,
        pl >= 0 ? '📈 Sold' : '📉 Sold'
      ),
    ],
  });
}

async function handlePortfolio(i) {
  const user = i.options.getUser('user') ?? i.user;
  const rows = q.holdings.all(user.id);
  if (!rows.length) return i.reply({ embeds: [embed(`${user} doesn't own any stocks. See \`/stocks\`.`, '💼 Portfolio')] });
  let value = 0;
  let cost = 0;
  const lines = rows.map((h) => {
    const price = q.lastPrice.get(h.sym)?.price ?? 0;
    const worth = h.shares * price;
    value += worth;
    cost += h.cost;
    const pl = worth - h.cost;
    return `**${h.sym}** × ${fmt(h.shares)} — ${fmt(worth)} ${ORB} (${pl >= 0 ? '+' : '-'}${fmt(Math.abs(pl))})`;
  });
  const pl = value - cost;
  return i.reply({
    embeds: [embed(`${lines.join('\n')}\n\nValue: **${fmt(value)}** ${ORB} · Paid: **${fmt(cost)}** ${ORB}\n${pl >= 0 ? 'Profit' : 'Loss'} if sold now (before fees): **${pl >= 0 ? '+' : '-'}${fmt(Math.abs(pl))}** ${ORB}`, `💼 ${user.username}'s portfolio`)],
  });
}

/* ───────────── Help ───────────── */

const HELP_TOPICS = {
  start: '🟠 Basics',
  earning: '🔨 Earning',
  shop: '🛒 Shop',
  progress: '⭐ Progress',
  social: '🏰 Clans',
  events: '🎉 Events',
  stocks: '📈 Stocks',
  robbery: '🦹 Robbery',
  admin: '🛠️ Admin',
};

const mins = (sec) => (sec >= 3600 ? `${sec / 3600}h` : `${sec / 60}m`);
const scaled = (n) => fmt(Math.floor(n * payoutMultiplier()));

// Built from the live settings so the numbers stay right when they're tuned.
function helpText(topic) {
  if (topic === 'earning') {
    const lines = Object.entries(ACTIONS).map(
      ([name, a]) => `\`/${name}\` (${mins(a.cooldown)}): ${scaled(a.min)}-${scaled(a.max)} ${ORB}, ${Math.round(a.bonusChance * 100)}% chance of x${a.bonusMult}`
    );
    return (
      `${lines.join('\n')}\n\n` +
      `**/quiz** is always a trivia question with ${TRIVIA_SECONDS}s to answer. Harder questions pay more (x${DIFF_MULT[1]} to x${DIFF_MULT[4]}), and you get ${QUIZ_SKIPS} skips to reroll a question.\n\n` +
      `**/daily** pays once per UTC day. Claiming on back-to-back days builds a streak worth more, up to day ${DAILY_MAX_STREAK}.\n\n` +
      `**Bot checks:** earn commands sometimes ask a quick question first. Answer in ${CHALLENGE_SECONDS}s (${TRIVIA_SECONDS}s for trivia) to get paid. ` +
      `${MAX_FAILS} misses lock you out of earning for ${mins(LOCK_SECONDS)}.\n\n` +
      `Payouts grow as the orb supply grows (\`/supply\`), so the numbers above go up over time.`
    );
  }
  if (topic === 'shop') {
    return (
      `\`/shop\` lists items and \`/buy\` gets one. Prices rise slowly as the supply grows.\n\n` +
      `**Tools:** the Diamond Pickaxe boosts \`/mine\` and the Good Fishing Rod boosts \`/fish\` by a random %. ` +
      `\`/upgrade\` raises the top of that range, up to level ${MAX_TOOL_LEVEL}. Each level costs twice the last.\n\n` +
      `**Salary boosts:** the Salary Raise (+5%) and Good Resumé (+25%) raise your role salary. You need a paid role, and only the best one counts.\n\n` +
      `**Roles:** Image Permissions and Admin Permissions give you the matching server role.\n\n` +
      `**Potions:** consumables like the Speed Potion (halves cooldowns for 30 min) and the Hourglass (resets them) stack in your \`/inventory\`. ` +
      `Buy several with \`/buy amount:\`, then drink one with \`/use\`. Each has a daily limit, and their prices grow with payouts.\n\n` +
      `**/pay** sends orbs to someone. ${Math.round(PAY_TAX * 100)}% is taxed back into the vault.`
    );
  }
  if (topic === 'progress') {
    return (
      `**Levels:** every orb you earn is XP. \`/level\` shows yours. At level ${MAX_LEVEL}, \`/prestige\` resets your level for a permanent ` +
      `+${Math.round(PRESTIGE_BONUS * 100)}% on earn payouts (up to ${MAX_PRESTIGE} times). You keep your orbs and items.\n\n` +
      `**Achievements:** \`/achievements\` lists ${ACHIEVEMENTS.length} goals, each paying a one-time reward.\n\n` +
      `**Secret Coins:** every paid earn has a ${Math.round(COIN_CHANCE * 100)}% chance to turn up a coin. There are three per earn command. ` +
      `\`/coins\` shows your collection, and completing a set pays a bonus.\n\n` +
      `**Seasons:** each season lasts ${SEASON_DAYS} days. Playing earns season points, and the ${SEASON_TIERS.length}-tier season pass pays out as you climb. ` +
      `The top 3 win prizes when the season ends. See \`/season\`.`
    );
  }
  if (topic === 'social') {
    return (
      `\`/clan create\` founds a clan for ${fmt(clanPrice())} ${ORB} (up to ${CLAN_MAX_MEMBERS} members). The owner uses \`/clan invite\`, ` +
      `and invited players use \`/clan join\` within ${CLAN_INVITE_DAYS} days.\n\n` +
      `\`/clan deposit\` puts orbs into the clan's upgrade fund. Deposits **can't be withdrawn**. The owner spends the fund with \`/clan upgrade\`, ` +
      `and each level (max ${CLAN_MAX_LEVEL}) gives every member +${Math.round(CLAN_BONUS * 100)}% on earn payouts.\n\n` +
      `\`/clan info\` and \`/clan top\` show clans. If the owner leaves, the longest-standing member takes over.`
    );
  }
  if (topic === 'events') {
    return (
      `**Orb drops:** an orb appears every ${DROP_MIN_MINUTES}-${DROP_MAX_MINUTES} minutes, and the first to click wins it. ` +
      `After a win, you sit out the next ${DROP_WAIT} drops.\n\n` +
      `**Raids:** a boss shows up every few days. Every earn command, \`/daily\` and drop win hits it. ` +
      `Beat it within ${RAID_HOURS}h and the reward is split by damage. See \`/raid status\`.\n\n` +
      `**Weekly challenge:** a server-wide goal that changes every Monday. Everyone who helps gets paid when it's done. See \`/weekly\`.\n\n` +
      `**Tournaments:** moderators run trivia tournaments. Answer fast and right to win, and the top 3 split the prize.\n\n` +
      `**Level of the Week:** beat the featured Geometry Dash level and send proof with \`/lotw submit\`. A moderator verifies it, and you're paid by its rating: per star for normal levels, more for harder demons.`
    );
  }
  if (topic === 'robbery') {
    return (
      `\`/rob @user\` tries to steal **${ROB_STEAL[0] * 100}-${ROB_STEAL[1] * 100}%** of their wallet. It works **${ROB_SUCCESS * 100}%** of the time, once an hour. ` +
      `${ROB_CUT * 100}% of the loot is dropped while escaping. Get caught and you're fined **${ROB_FINE * 100}%** of your orbs **and banned from the bot for ${ROB_JAIL / 3600}h**.\n\n` +
      `**Call the police:** every robbery takes ${ROB_WINDOW}s. Anyone can click 🚨 **Call the police** and pass a quick check to stop it. ` +
      `The robber gets caught, and pays the caller ${POLICE_REWARD * 100}% of their orbs on top of the fine.\n\n` +
      `**Staying safe**\n` +
      `🏦 \`/bank deposit\`: banked orbs can't be stolen. Your bank holds more as you level up.\n` +
      `🛡️ **Padlock** (\`/shop\`): guards your wallet for 24h. The next robber fails and gets fined.\n` +
      `🏦 During a robbery you get a DM, so you can call the police yourself or bank your orbs in time.\n` +
      `🕶️ After you're robbed, nobody can rob you for ${ROB_SHIELD / 3600}h.\n\n` +
      `Wallets under ${scaled(ROB_MIN_TARGET)} ${ORB} aren't worth robbing, and you need ${scaled(ROB_MIN_ROBBER)} ${ORB} yourself to cover a fine.`
    );
  }
  if (topic === 'stocks') {
    const list = q.listedStocks.all();
    const levels = list.filter((x) => x.kind === 'level').map((x) => `**${x.sym}** ${x.name}`).join(', ') || 'none yet';
    const players = list.filter((x) => x.kind === 'player').map((x) => `**${x.sym}** ${x.name}`).join(', ') || 'none';
    return (
      `Stocks move with real Geometry Dash stats, updated every ${STOCK_POLL_MINUTES} minutes.\n\n` +
      `**Level stocks** (${levels}) rise when the level gets played more than usual. The price compares its downloads in the last 24h with its average day.\n\n` +
      `**Player stocks** (${players}) follow that player's Demonlist score, so they jump when the player beats a new demon.\n\n` +
      `A stock at its usual level is worth about **${fmt(STOCK_BASE)}** ${ORB}. \`/stocks\` shows prices, \`/stock buy\` and \`/stock sell\` trade (${STOCK_FEE * 100}% fee each way), and \`/portfolio\` shows your profit or loss.\n\n` +
      `**Want another level?** \`/stock propose level_id\` suggests any level with ${fmt(STOCK_MIN_DOWNLOADS)}+ downloads. If a moderator approves it, it trades after ${STOCK_WARMUP_HOURS}h of data.\n\n` +
      `If the data for a stock stops updating, trading on it pauses until it's back. Big moves are announced in the event channel.`
    );
  }
  if (topic === 'admin') {
    return (
      `These need **Manage Server**:\n` +
      `\`/salary set|remove|list\`: automatic role payments every ${SALARY_INTERVAL_MIN} min\n` +
      `\`/raid start\`: summon a raid boss in the current channel\n` +
      `\`/tournament\`: run a trivia tournament in the current channel\n` +
      `\`/lotw set|end\`: choose the Level of the Week. Clears and stock proposals are sent to every moderator by DM with Approve and Reject buttons\n` +
      `\`/stock add|remove\`: list a level or delist a stock (holders are paid the last price). \n\n` +
      `Optional settings: \`DROP_CHANNEL_ID\` (drops), \`EVENT_CHANNEL_ID\` (raids and announcements), \`REVIEW_CHANNEL_ID\` (stock proposals and clears), ` +
      `\`SEASON_ROLE_ID\` (season champion). See the README.`
    );
  }
  return (
    `Mana orbs ${ORB} are this server's currency. Earn them, level up, and spend them in the shop.\n\n` +
    `**Start here**\n\`/daily\` claim free orbs every day\n\`/work\` \`/build\` \`/fish\` \`/mine\` \`/quiz\` earn orbs (each has a cooldown)\n` +
    `\`/balance\` \`/leaderboard\` check orbs\n\`/shop\` \`/buy\` spend them\n\n` +
    `Pick a topic below to learn more.`
  );
}

const helpRows = (active) => {
  const buttons = Object.entries(HELP_TOPICS).map(([key, label]) =>
    new ButtonBuilder().setCustomId(`help:${key}`).setLabel(label).setStyle(key === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(buttons.slice(0, 5)), new ActionRowBuilder().addComponents(buttons.slice(5))];
};

const helpPage = (topic) => ({
  embeds: [embed(helpText(topic), `📖 Help: ${HELP_TOPICS[topic].replace(/^\S+ /, '')}`)],
  components: helpRows(topic),
});

const handleHelp = (i) => i.reply({ ...helpPage(i.options.getString('topic') ?? 'start'), flags: EPH });
const handleHelpButton = (i) => i.update(helpPage(HELP_TOPICS[i.customId.split(':')[1]] ? i.customId.split(':')[1] : 'start'));

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
  const title = golden ? '✨ Golden Orb' : `${ORB} Orb Drop`;
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

// Connection logging, so a stalled start shows where it stopped. Discord's login limit
// ("session limit") is the usual silent culprit: discord.js waits until it resets.
// Set DEBUG_DISCORD=1 to see every gateway message.
client.on(Events.Debug, (msg) => {
  if (process.env.DEBUG_DISCORD === '1' || (/session limit|remaining|identif|ready|invalid|close|rate ?limit|fetched gateway/i.test(msg) && !/heartbeat/i.test(msg))) {
    console.log('[discord]', msg);
  }
});
client.on(Events.Warn, (msg) => console.warn('[discord warning]', msg));
client.on(Events.Error, (err) => console.error('[discord error]', err));
client.on(Events.ShardDisconnect, (e, id) => console.warn(`[discord] shard ${id} disconnected (code ${e?.code})`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[discord] shard ${id} reconnecting`));

// Log stray errors instead of crashing; a crash-restart loop can use up Discord's daily logins.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
client.rest.on('rateLimited', (info) => console.warn('[discord] rate limited:', JSON.stringify(info)));

// Asks Discord directly whether this host can reach it, outside discord.js (which waits silently
// on bans and rate limits). Prints the status, any retry-after, and the daily login (session) limit.
async function checkDiscordReachable() {
  try {
    const res = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 400);
    const retry = res.headers.get('retry-after');
    console.log(`[discord] reachability check: HTTP ${res.status}${retry ? `, retry after ${retry}s` : ''}: ${body}`);
  } catch (err) {
    console.error('[discord] reachability check: could not reach discord.com:', err.message);
  }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isAutocomplete()) {
    const jailed = q.getBuff.get(i.user.id, 'jail')?.until ?? 0;
    if (jailed > nowSec()) {
      return i
        .reply({ content: `🚔 You got caught robbing someone and are banned from the bot until <t:${jailed}:f> (<t:${jailed}:R>).`, flags: EPH })
        .catch(() => {});
    }
  }
  if (i.isButton()) {
    const handler =
      { drop: handleDropButton, tn: handleTournamentButton, lotw: handleLotwButton, help: handleHelpButton, stk: handleStockButton, pol: handlePoliceButton }[i.customId.split(':')[0]] ??
      handleChallengeButton;
    return handler(i).catch(async (err) => {
      console.error(err);
      const msg = { content: '❌ Something broke. Try again.', flags: EPH };
      await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
    });
  }
  if (i.isAutocomplete()) return stockAutocomplete(i).catch(console.error);
  if (!i.isChatInputCommand()) return;
  if (!i.inGuild()) return fail(i, 'Use me in a server.');

  try {
    const cmd = i.commandName;
    if (ACTIONS[cmd]) return await handleEarn(i, cmd);

    switch (cmd) {
      case 'balance': {
        const user = i.options.getUser('user') ?? i.user;
        const bank = q.getBank.get(user.id)?.bank ?? 0;
        return i.reply({ embeds: [embed(`${user} has **${fmt(getBalance(user.id))}** ${ORB} in their wallet and **${fmt(bank)}** ${ORB} in the bank.`, 'Mana Orbs')] });
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
      case 'use':
        return await handleUse(i);
      case 'stocks':
        return await handleStocks(i);
      case 'stock':
        return await handleStock(i);
      case 'rob':
        return await handleRob(i);
      case 'bank':
        return await handleBank(i);
      case 'portfolio':
        return await handlePortfolio(i);
      case 'inventory':
        return await handleInventory(i);
      case 'buy':
        return await handleBuy(i);
      case 'leaderboard': {
        const rows = q.top.all();
        const medals = ['🥇', '🥈', '🥉'];
        const text = rows.length
          ? rows.map((r, n) => `${medals[n] ?? `**${n + 1}.**`} <@${r.id}> — ${fmt(r.total)} ${ORB}`).join('\n')
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
      case 'coins':
        return await handleCoins(i);
      case 'tournament':
        return await handleTournament(i);
      case 'weekly':
        return await handleWeekly(i);
      case 'season':
        return await handleSeason(i);
      case 'lotw':
        return await handleLotw(i);
      case 'help':
        return await handleHelp(i);
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
  setInterval(() => seasonTick().catch(console.error), 60 * 1000);
  stockTick().catch(console.error);
  setInterval(() => stockTick().catch(console.error), STOCK_POLL_MINUTES * 60 * 1000);
});

checkDiscordReachable();
setTimeout(() => {
  if (!client.isReady()) console.warn('[discord] still not connected after 60s. See the reachability check above.');
}, 60_000).unref();
console.log('Logging in to Discord…');
client
  .login(TOKEN)
  .then(() => console.log('Connected to the gateway, waiting for servers to load…'))
  .catch((err) => {
    console.error('Discord login failed:', err.message);
    process.exit(1);
  });
