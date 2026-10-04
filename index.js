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

// Anti-AFK / anti-bot checks
const CHALLENGE_CHANCE = 0.2; // random chance per earn command
const FORCE_AFTER = 10; // always check after this many earns without one
const CHALLENGE_SECONDS = 30; // time to answer
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
    desc: '+2-10% (random) on every /mine payout.',
    price: 5_000,
    perk: { action: 'mine', min: 2, max: 10 },
  },
  good_rod: {
    name: '🎣 Good Fishing Rod',
    desc: '+2-15% (random) on every /fish payout.',
    price: 4_000,
    perk: { action: 'fish', min: 2, max: 15 },
  },
};

const ACTIONS = {
  work: {
    emoji: '🔨',
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

// Orbs can only be minted while circulation is below the cap. Returns what was actually granted.
const mintTx = db.transaction((uid, amount) => {
  q.ensure.run(uid);
  const granted = Math.max(0, Math.min(amount, mintable()));
  if (granted > 0) q.add.run(granted, granted, uid);
  return granted;
});

const earnTx = db.transaction((uid, action, amount, now) => {
  q.setCd.run(uid, action, now);
  return mintTx(uid, amount);
});

const transferTx = db.transaction((from, to, amount) => {
  q.ensure.run(from);
  q.ensure.run(to);
  if (getBalance(from) < amount) return false;
  q.sub.run(amount, from);
  q.add.run(amount, amount, to);
  return true;
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
const fail = (i, msg) => i.reply({ content: `❌ ${msg}`, flags: EPH });

// Salary boosts don't stack: the best owned one applies.
const salaryBoost = (uid) =>
  Math.max(0, ...Object.entries(SHOP).filter(([k, s]) => s.salaryBoost && q.hasItem.get(uid, k)).map(([, s]) => s.salaryBoost));

// True if the member holds any role that has a /salary payout in this guild.
const hasPaidSalary = (member, guildId) =>
  q.salaries.all(guildId).some((r) => member.roles.cache.has(r.role_id));

/* ───────────── Commands ───────────── */

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your mana orbs')
    .addUserOption((o) => o.setName('user').setDescription('Someone else')),
  ...Object.keys(ACTIONS).map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(`${ACTIONS[name].emoji} Earn mana orbs by ${name === 'work' ? 'working' : name === 'build' ? 'building' : name === 'fish' ? 'fishing' : 'mining'}`)
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

/* ───────────── Handlers ───────────── */

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
  { q: 'Which is the first official Geometry Dash level?', a: 'Stereo Madness', w: ['Back On Track', 'Polargeist', 'Dry Out', 'Base After Base'] },
  { q: 'Which is the second official level?', a: 'Back On Track', w: ['Stereo Madness', 'Polargeist', 'Dry Out', 'Base After Base'] },
  { q: 'Which is the third official level?', a: 'Polargeist', w: ['Stereo Madness', 'Back On Track', 'Dry Out', 'Base After Base'] },
  { q: 'Who created Geometry Dash?', a: 'RobTop', w: ['Zobros', 'Riot', 'Sailent', 'Hinds'] },
  { q: 'Which game mode flies like a rocket?', a: 'Ship', w: ['Cube', 'Ball', 'Wave', 'Robot'] },
  { q: 'Which game mode zig-zags diagonally?', a: 'Wave', w: ['Cube', 'Ship', 'Ball', 'UFO'] },
];

const SYMBOLS = [
  ['mana orb', '🟠'], ['star', '⭐'], ['moon', '🌙'], ['spike', '🔺'],
  ['key', '🔑'], ['diamond', '💎'], ['skull', '💀'], ['fire', '🔥'],
];

function makeChallenge() {
  const kind = pick(['math', 'trivia', 'symbol']);

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
    const t = pick(TRIVIA);
    const options = shuffle([t.a, ...shuffle(t.w).slice(0, 3)]);
    return { prompt: t.q, options, answer: options.indexOf(t.a) };
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

async function sendChallenge(i, reward) {
  const ch = makeChallenge();
  const id = Math.random().toString(36).slice(2, 10);
  const row = new ActionRowBuilder().addComponents(
    ch.options.map((label, n) =>
      new ButtonBuilder().setCustomId(`ch:${id}:${n}`).setLabel(label).setStyle(ButtonStyle.Secondary)
    )
  );

  const entry = { userId: i.user.id, reward, answer: ch.answer, timer: null };
  entry.timer = setTimeout(() => {
    if (!pending.delete(id)) return;
    const lockedUntil = recordFail(i.user.id);
    const extra = lockedUntil ? `\n🔒 Too many fails. Locked <t:${lockedUntil}:R>.` : '';
    i.editReply({ embeds: [embed(`⏰ Too slow, no orbs this time.${extra}`, '🤖 Bot check failed')], components: [] }).catch(() => {});
  }, CHALLENGE_SECONDS * 1000);
  pending.set(id, entry);

  return i.reply({
    embeds: [embed(`${ch.prompt}\n\nAnswer within **${CHALLENGE_SECONDS}s** to claim **${fmt(reward.amount)}** ${ORB}`, '🤖 Bot check')],
    components: [row],
  });
}

async function handleChallengeButton(i) {
  const [tag, id, n] = i.customId.split(':');
  if (tag !== 'ch') return;
  const p = pending.get(id);
  if (!p) return i.reply({ content: '❌ That check expired.', flags: EPH });
  if (p.userId !== i.user.id) return i.reply({ content: "❌ This isn't your check.", flags: EPH });

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
  for (const [key, s] of Object.entries(SHOP)) {
    if (s.perk?.action === name && q.hasItem.get(uid, key)) amount = Math.floor(amount * (1 + rand(s.perk.min, s.perk.max) / 100));
  }
  let bonus = '';
  if (Math.random() < a.bonusChance) {
    amount *= a.bonusMult;
    bonus = `\n✨ **${a.bonusText}** (x${a.bonusMult})`;
  }
  const reward = { name, amount, bonus, line: pick(a.lines) };

  s.streak += 1;
  if (Math.random() < CHALLENGE_CHANCE || s.streak >= FORCE_AFTER) {
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
  const key = i.options.getString('item');
  const item = SHOP[key];
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
  return i.reply({
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

/* ───────────── Client ───────────── */

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.on(Events.InteractionCreate, async (i) => {
  if (i.isButton()) return handleChallengeButton(i).catch(console.error);
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
        if (!transferTx(i.user.id, target.id, amount)) {
          return fail(i, `You only have **${fmt(getBalance(i.user.id))}** ${ORB}.`);
        }
        return i.reply({ content: `${ORB} ${i.user} paid ${target} **${fmt(amount)}** mana orbs.` });
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
          ([, s]) => `**${s.name}** — ${fmt(s.price)} ${ORB}\n${s.desc}`
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
      const members = await guild.members.fetch();
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
  try {
    if (GUILD_ID) {
      const guild = await c.guilds.fetch(GUILD_ID);
      await guild.commands.set(commands);
    } else {
      await c.application.commands.set(commands);
    }
    console.log('Slash commands registered');
  } catch (err) {
    console.error('Command registration failed:', err.message);
  }
  setInterval(() => salaryTick().catch(console.error), 60 * 1000);
});

client.login(TOKEN);
