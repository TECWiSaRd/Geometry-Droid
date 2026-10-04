# GD Mana Orbs Bot

Geometry Dash themed Discord economy bot.

## Commands
- `/help [topic]`: private guide with pages for basics, earning, shop, progress, clans, events and admin commands. Numbers come from the live settings
- `/balance [user]`, `/leaderboard`
- `/work` (5m), `/build` (10m), `/fish` (3m), `/mine` (15m): earn orbs, with rare bonus rolls
- `/quiz` (3m): answer a Geometry Dash trivia question within 30s. Base 200-500 orbs, scaled by question difficulty (0.5x to 3x). Up to 3 skips reroll the question. Always a challenge; wrong answers count as fails
- `/pay user amount`: 10% tax (rounded up) goes back to the vault; transfers must be at least 2 orbs
- `/daily`: claim once per UTC day; consecutive days raise the reward (max bonus at day 10)
- `/upgrade tool`: Diamond Pickaxe and Good Fishing Rod go up to level 5, raising the random payout bonus and costing more each level
- `/changelog`: shows the latest commit on GitHub (set `GITHUB_TOKEN` only if the repo is private; `CHANGELOG_REPO` overrides the repo)
- `/achievements [user]`: 19 one-time achievements (earn counts, quiz streaks, drops, daily streak) that pay a scaled orb reward. `/level` shows your badge count
- `/clan create|invite|join|leave|kick|deposit|upgrade|info|top`: clans of up to 20. Founding costs 25,000 (scales like shop prices). Deposits go into an upgrade fund that can never be withdrawn; the owner spends it on clan levels (up to 5), and each level gives every member +1% on earn payouts. If the owner leaves, the longest-standing member takes over
- `/raid status|start`: a raid boss spawns in the event channel (`EVENT_CHANNEL_ID`, or `DROP_CHANNEL_ID` if unset) an hour after startup, then 72h after each raid ends. HP is 300 per server member (min 3,000). Earn commands, `/daily` and drop wins hit it (10% crit chance). Defeat it within 48h and a 50,000 pool (scales with payouts) is split by damage. Manage Server can start one in the current channel with `/raid start`
- `/coins [user]`: 15 Secret Coins, three per earn command (named after the first five official levels). Each paid earn has a 3% chance to find one you are missing. Completing a set pays 5,000 (scales with payouts); finding all 15 unlocks the Completionist achievement
- `/tournament [rounds]` (Manage Server): trivia tournament in the current channel. 60s to join, then 3-10 rounds (default 5) of 30s questions. Right answers score 100 x difficulty plus up to 50 for speed. Top 3 split a 30,000 pool (scales with payouts) 50/30/20. Needs 3+ players; a restart ends a running tournament
- `/weekly`: a server-wide goal that rotates every Monday (UTC), e.g. "Mine 40 times as a server". The target scales with players active in the last 7 days (min 5). When it is met, everyone who contributed gets 5,000 (scales with payouts) and it is announced in the event channel
- `/season`: 30-day seasons counted from the bot's first start. Orbs earned through play give season points (in base orbs, so later seasons are not inflated). A 10-tier season pass pays out automatically as you climb. When a season ends the top 3 get 100,000 / 50,000 / 25,000 (scale with payouts), results are announced in the event channel, and `SEASON_ROLE_ID` (optional) moves to the new #1. Set `SEASON_RESETS_PRESTIGE = true` in `index.js` to also wipe XP and prestige each season (off by default)
- `/lotw info|submit|set|end`: Level of the Week. A moderator (Manage Server) features a level with `/lotw set level_id name stars`. Players beat it and send a screenshot or video with `/lotw submit`; the bot re-uploads it to `LOTW_REVIEW_CHANNEL_ID` (or the current channel) with Approve/Reject buttons for moderators. You cannot review your own clear, and rejected players can resubmit. A verified clear pays 2,000 per star (scales with payouts)
- `/level`, `/prestige`: earn XP from your payouts. Reach level 50 to prestige, which resets XP for +2% payouts per prestige (max 10)
- `/shop`, `/buy item`: Image Permissions (1,000), Admin Permissions (1 trillion), Salary Raise (20,000, +5% salary), Good Resumé (500,000, +25% salary), Diamond Pickaxe (5,000, +2-10% mining), Good Fishing Rod (4,000, +2-15% fishing)
- `/buy item amount`, `/use item`, `/inventory`: consumables you stack (up to 20 each) and use later. Speed Potion (3,000): halves all earn cooldowns for 30 min, 2 per UTC day. Chamber of Time Hourglass (800): resets all earn cooldowns, 3 per UTC day. Unlike other shop items, their prices scale with payouts so they never become a free money loop. `/inventory` also shows active effects and tool levels
- `/salary set|remove|list` (Manage Server): automatic role payments

## Discord setup
1. discord.com/developers → New Application → Bot → copy the **token**.
2. Bot tab → enable **Server Members Intent**.
3. Invite with scopes `bot` + `applications.commands` and permission **Manage Roles**.
4. In your server, create two roles: **Image Perms** and **Admin** (give Admin the Administrator permission).
   - For Image Perms: deny *Attach Files* and *Embed Links* for @everyone, allow them for the Image Perms role.
5. Drag the bot's role **above** both of those roles (Server Settings → Roles).
6. Enable Developer Mode, right-click each role → Copy Role ID.

## Railway deploy
1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Add a **Volume** to the service, mount path `/data` (keeps balances across deploys).
4. Variables:

```
DISCORD_TOKEN=your-bot-token
GUILD_ID=your-server-id
IMAGE_ROLE_ID=role-id
ADMIN_ROLE_ID=role-id
DB_PATH=/data/orbs.db
SALARY_INTERVAL_MINUTES=60
# ADMIN_PRICE=1000000000000   (optional override)
# ORB_EMOJI=<:name:emoji-id>        optional; overrides the default <:Mana_Orbs:1556341873054843022>
# Optional channels and roles:
# DROP_CHANNEL_ID=channel-id          orb drops
# EVENT_CHANNEL_ID=channel-id         raids, weekly and season announcements (defaults to DROP_CHANNEL_ID)
# LOTW_REVIEW_CHANNEL_ID=channel-id   where Level of the Week proofs are reviewed (defaults to the channel used)
# SEASON_ROLE_ID=role-id              given to each season's #1 (the bot's role must be above it)
# GITHUB_TOKEN=token                  only needed for /changelog if the repo is private
```

The bot needs View Channel, Send Messages, Embed Links and Attach Files in the drop, event and review channels.

Railway runs `npm start` automatically.

## Supply
Circulation is capped at 500,000,000 orbs on launch day, and the cap grows linearly by about 11.1 billion per day, reaching 2 trillion after 180 days (it keeps growing at that rate after). Earn commands and salaries can only mint orbs while circulation is under the cap; orbs spent in the shop go back into the vault. Earn payouts scale up with the cap so the economy keeps pace. `/supply` shows the numbers. Settings are at the top of `index.js`.

## Anti-bot checks
`/work`, `/build`, `/fish` and `/mine` sometimes (20% of the time, and always after 10 in a row) show a button challenge: math, GD trivia, or "click the orb". Orbs are paid only if you answer correctly within 10s (30s for trivia). 3 fails locks you out of earning for 1 hour. Tune `CHALLENGE_CHANCE`, `FORCE_AFTER`, `CHALLENGE_SECONDS`, `MAX_FAILS` and `LOCK_SECONDS` at the top of `index.js`.

## Salaries
Example: `/salary set @Owner 50000`, `/salary set @Admin 20000`, `/salary set @Mod 5000`. Everyone with the role is paid every `SALARY_INTERVAL_MINUTES`. If someone has several paid roles they get the highest one only.

## Orb drops
Set `DROP_CHANNEL_ID` to a channel and the bot posts an orb drop every 20-40 minutes. The first person to click "Grab it!" wins. Golden Orbs (about 1 in 7) pay 5x. After winning, you must sit out the next 5 drops before you can win again. Unclaimed drops expire after 10 minutes. The bot needs View Channel and Send Messages in that channel. Live drops are closed out on restart.

## Tweaking
Edit `SHOP` and `ACTIONS` at the top of `index.js` for prices, cooldowns, payouts and flavor text. Shop prices rise 4% per doubling of the supply cap (`PRICE_SCALE`), so they grow much more slowly than payouts.

