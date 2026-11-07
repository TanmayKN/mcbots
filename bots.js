const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin

const HOST = '127.0.0.1'  // ViaProxy (forwards to the server set in start.sh)
const PORT = 25568
const PASSWORD = 'botpass123'  // password used for /register and /login on servers that need it
const MAX_BOTS = 8  // a handful for a friends' world; more than this is a server flood, not a visit

// Usage: node bots.js [count] [target] [name(s)] [kill message]
//   e.g.  node bots.js 5 Steve hi "gg {target}"  -> hi1..hi5 hunting Steve
//         node bots.js 0 Steve "Bob Alex Max"    -> exactly Bob, Alex, Max hunting Steve
// Anything left out gets asked in the terminal.
// In-game chat: "bots kill <name>", "bots follow", "bots come", "bots goto <x> <y> <z>",
//               "bots end", "bots portal", "bots stop", "bots leave"
let target = null   // player all bots hunt (shared, can be changed from chat)
let lastKill = 0    // so only one bot reacts to each kill
let killMessage = '{target} got destroyed by {bot} 💀'  // {target} and {bot} get filled in
let startCoords = null  // {x,y,z} the bots walk to right after joining, if setup set one
let startFollow = null  // player the bots follow from the moment they join, if setup chose "follow"

// What a grave can look like, depending on the server's grave plugin. Add names here if yours differs.
const GRAVE_BLOCKS = ['player_head', 'player_wall_head', 'skeleton_skull', 'chest', 'barrel']
const isGrave = b => b && (GRAVE_BLOCKS.includes(b.name) || b.name.includes('grave'))

// fails: how many times in a row this bot has failed to get in (for backing off)
function makeBot (name, fails = 0) {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: name,
    auth: 'offline',
    version: '26.1'
  })
  // mineflayer-pvp still listens to the old 'physicTick' event, which spams a deprecation warning.
  // Hand it the new 'physicsTick' event instead (same timing).
  const on = bot.on.bind(bot)
  bot.on = (event, fn) => on(event === 'physicTick' ? 'physicsTick' : event, fn)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)

  // 26.3 servers kick with invalid_player_movement unless the client ends each tick
  // with a tick_end packet like the real game does; mineflayer doesn't send it on its own.
  bot.on('physicsTick', () => bot._client.write('tick_end', {}))

  bot.once('spawn', () => {
    console.log(`${name} joined`)
    fails = 0
    bot.pathfinder.setMovements(new Movements(bot))
    probeAcceptCommand()  // learn which /tp...accept command this server uses
    if (startCoords) goTo(startCoords)

    // Every second: chase and hit the target if it's nearby, otherwise wander around.
    loop = setInterval(() => {
      if (busy) return
      const enemy = target && bot.players[target] && bot.players[target].entity
      if (enemy) {
        if (bot.pvp.target !== enemy) {
          equipWeapon(bot)
          bot.pvp.attack(enemy)
        }
        return
      }
      if (bot.pvp.target) bot.pvp.stop()
      if (following) return followTick()
      if (bot.pathfinder.isMoving()) return  // walking to a portal
      if (Math.random() < 0.5) {
        bot.setControlState('forward', Math.random() > 0.5)
        bot.setControlState('jump', Math.random() > 0.7)
        bot.look(Math.random() * Math.PI * 2, 0)
      }
    }, 1000)
  })

  bot.on('death', () => console.log(`${name} died, respawning`))

  // Following a player, including through nether/end portals they walk into.
  let following = startFollow  // set at launch if you chose "follow" in setup
  let followed = null  // the entity the follow goal is currently locked on
  let lastSeen = null  // where the followed player was last seen
  bot.on('spawn', () => { followed = null })  // also fires after changing dimension

  function followTick () {
    const p = bot.players[following] && bot.players[following].entity
    if (p) {
      lastSeen = p.position.clone()
      if (followed !== p) {
        bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
        followed = p
      }
      return
    }
    followed = null
    // They vanished: if they were standing at a portal, go through it after them.
    if (lastSeen) {
      const portal = findPortal(['end_portal', 'nether_portal', 'end_gateway'], lastSeen, 4)
      if (portal) {
        console.log(`${name} following ${following} through the ${portal.name}`)
        enterPortal(portal)
      }
      lastSeen = null
    }
  }

  function findPortal (names, point, maxDistance) {
    const ids = names.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    return bot.findBlock({ point, matching: ids, maxDistance })
  }

  function enterPortal (block) {
    const { x, y, z } = block.position
    bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
  }

  function goThroughPortal (names, label) {
    const portal = findPortal(names, bot.entity.position, 64)
    if (!portal) return bot.chat(`I can't see ${label} near me`)
    console.log(`${name} heading into the ${portal.name} at ${portal.position}`)
    following = null
    enterPortal(portal)
  }

  // Walk to an x y z. The pathfinder only works within the loaded world, so very far
  // coordinates get there a chunk at a time as the world loads around the bot.
  function goTo ({ x, y, z }) {
    following = null
    target = null
    console.log(`${name} walking to ${x} ${y} ${z}`)
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1))
  }

  // When the target dies: one bot brags in chat, then walks over and breaks the grave.
  let busy = false
  bot.on('entityDead', (entity) => {
    if (!target || entity.username !== target || Date.now() - lastKill < 3000) return
    if (entity.position.distanceTo(bot.entity.position) > 16) return
    lastKill = Date.now()
    const where = entity.position.clone()
    bot.chat(killMessage.replaceAll('{target}', target).replaceAll('{bot}', name))
    breakGrave(where)
  })

  async function breakGrave (where) {
    busy = true
    bot.pvp.stop()
    try {
      await bot.waitForTicks(30)  // give the grave a moment to appear
      const spots = bot.findBlocks({ point: where, matching: b => isGrave(b), maxDistance: 5, count: 3 })
      if (spots.length === 0) console.log(`${name}: no grave found near ${where.floored()}`)
      for (const spot of spots) {
        const block = bot.blockAt(spot)
        if (!isGrave(block)) continue
        await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 2))
        await bot.dig(block)
        console.log(`${name} broke ${block.name} at ${spot}`)
      }
    } catch (e) {
      console.log(`${name} couldn't break the grave:`, e.message)
    }
    busy = false
  }

  // When a bot gets disconnected, it rejoins 5 seconds later with the same name.
  // It stays out if it left with "bots leave", was banned, or someone else logged in with
  // its name (rejoining would just kick that player off in a loop). If the server only said
  // "joining too fast", it retries after a random short wait instead.
  let loop = null
  let leaving = false
  let banned = false
  let taken = false
  let throttled = false
  bot.on('end', () => {
    clearInterval(loop)
    if (leaving || banned) return console.log(`${name} left`)
    if (taken) return console.log(`${name} left: someone else is playing with that name`)
    if (throttled) {
      console.log(`${name} joined too fast, retrying`)
      return setTimeout(() => makeBot(name, fails), 3000 + Math.random() * 5000)
    }
    // Couldn't get in (server down or closed): wait longer each time, give up after 6 tries.
    if (!bot.entity) fails++
    if (fails >= 6) return console.log(`${name} gave up: can't reach the server (is the world open?)`)
    const wait = Math.min(5000 * 2 ** fails, 60000)
    console.log(`${name} disconnected, rejoining in ${wait / 1000}s`)
    setTimeout(() => makeBot(name, fails), wait)
  })

  // Different teleport plugins use different accept commands. Try the common ones once at
  // startup; the server replies "unknown command" (or echoes it back with a "<--[HERE]"
  // error pointer) to the wrong ones. Whatever gets a real reply is the command this server
  // uses. Once found, re-send it on a gentle timer so every request is always accepted.
  const ACCEPT_CANDIDATES = ['tpyes', 'tpaccept', 'tpaaccept', 'tpac', 'taccept', 'tpallow']
  let acceptCmd = null
  let probing = false
  let lastProbe = ''

  function probeAcceptCommand () {
    probing = true
    let i = 0
    const next = () => {
      if (!probing) return
      if (i >= ACCEPT_CANDIDATES.length) {
        probing = false
        if (!acceptCmd) console.log(`[${name}] none of the usual accept commands worked — tell me the server's command`)
        return
      }
      lastProbe = ACCEPT_CANDIDATES[i++]
      bot.chat('/' + lastProbe)
      setTimeout(next, 800)
    }
    next()
  }

  function useAcceptCmd (cmd) {
    acceptCmd = cmd
    probing = false
    console.log(`[${name}] accept command on this server is /${cmd}`)
    bot.chat('/' + cmd)                          // take any request already waiting
    setInterval(() => bot.chat('/' + cmd), 5000) // and keep accepting, always
  }

  // Lines that mean "that command doesn't exist here": the plain error, or the echo of the
  // bad command with the "<--[HERE]" pointer the server appends.
  const isUnknownCmd = m => /unknown or incomplete command|unknown command|<--\[here\]/.test(m)

  let lastTpa = 0
  let lastAuth = 0
  bot.on('messagestr', (msg) => {
    if (process.env.DEBUG) console.log(`[${name}] ${msg}`)  // set DEBUG=1 to see server chat
    const m = msg.toLowerCase()

    // AuthMe-style login plugins: when the server tells the bot to register or log in, do it.
    // Register uses the password twice; login once. Harmless on servers that never ask.
    if (Date.now() - lastAuth > 1500) {
      if (/register/.test(m) && /password|\/register|register (with|using|now|first|to play)/.test(m)) {
        lastAuth = Date.now()
        bot.chat(`/register ${PASSWORD} ${PASSWORD}`)
      } else if (/log ?in/.test(m) && /password|\/l(ogin)?\b|login (with|using|now|first|to play)/.test(m)) {
        lastAuth = Date.now()
        bot.chat(`/login ${PASSWORD}`)
      }
    }

    // While probing: the first candidate that does NOT draw an "unknown command" reply is real.
    if (probing && lastProbe && !acceptCmd && !isUnknownCmd(m)) {
      useAcceptCmd(lastProbe)
    }

    // Instantly accept the moment a request text appears, too.
    const isTpa =
      /\btpa(here)?\b/.test(m) ||
      (/teleport/.test(m) && /request|wants|asked|would like|has sent|to you|to teleport/.test(m))
    if (isTpa && Date.now() - lastTpa > 1500) {
      lastTpa = Date.now()
      bot.chat('/' + (acceptCmd || 'tpyes'))
    }
  })

  bot.on('chat', (user, msg) => {
    const [cmd, action, who] = msg.trim().split(/\s+/)
    if (cmd !== 'bots') return
    if (action === 'leave') { leaving = true; bot.quit() }
    if (action === 'stop') {
      if (target) console.log('Stopped hunting', target)
      target = null
      following = null
      bot.pvp.stop()
      bot.pathfinder.setGoal(null)
    }
    if (action === 'follow') {
      following = who || user
      console.log(`${name} following ${following}`)
    }
    if (action === 'come') bot.chat(`/tpa ${who || user}`)  // works across dimensions if the server has /tpa
    if (action === 'goto') {
      const nums = msg.trim().split(/\s+/).slice(2).map(Number)
      if (nums.length === 3 && nums.every(Number.isFinite)) goTo({ x: nums[0], y: nums[1], z: nums[2] })
      else bot.chat('usage: bots goto <x> <y> <z>')
    }
    if (action === 'end') goThroughPortal(['end_portal'], 'an End portal')
    if (action === 'portal') goThroughPortal(['end_portal', 'nether_portal', 'end_gateway'], 'a portal')
    if (action === 'kill' && who && who !== target) {
      target = who
      console.log('Now hunting', target)
    }
  })

  bot.on('kicked', r => {
    const reason = typeof r === 'string' ? r : JSON.stringify(r)
    if (/bann?ed/i.test(reason)) banned = true
    if (/duplicate_login|logged in from another location|already (online|connected|playing)/i.test(reason)) taken = true
    if (/throttl|too fast|wait before|too many connections/i.test(reason)) throttled = true
    console.log(`${name} kicked:`, reason)
  })
  bot.on('error', e => console.log(`${name} error:`, e.message))
}

// Hold the best sword or axe in the inventory, if there is one.
function equipWeapon (bot) {
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
  const weapons = bot.inventory.items().filter(i => /_(sword|axe)$/.test(i.name))
  weapons.sort((a, b) => order.findIndex(m => a.name.startsWith(m)) - order.findIndex(m => b.name.startsWith(m)))
  if (weapons[0]) bot.equip(weapons[0], 'hand').catch(() => {})
}

// One word = a prefix numbered up to count (hi -> hi1, hi2...). Several words = exactly those names.
function parseNames (input) {
  const words = (input || '').split(/[\s,]+/).filter(Boolean)
  if (words.length > 1) {
    const bad = words.find(w => !/^\w{3,16}$/.test(w))
    return bad ? { error: `"${bad}" isn't a valid name (3-16 letters, numbers or _).` } : { names: words }
  }
  const prefix = words[0] || 'bot'
  return /^\w{1,13}$/.test(prefix) ? { prefix } : { error: 'Use only letters, numbers or _ (max 13 characters).' }
}

function start (count, who, picked) {
  target = who || null
  // A list is used as typed (duplicates dropped); one name for one bot is used exactly (RN07, not RN071).
  const names = picked.names ? [...new Set(picked.names)]
    : count === 1 ? [picked.prefix]
      : Array.from({ length: count }, (_, i) => `${picked.prefix}${i + 1}`)
  console.log(`Starting ${names.join(', ')}` + (target ? `, hunting ${target}` : ', not hunting anyone'))
  names.forEach(makeBot)  // all at once
}

// Launch straight from a config object (passed in the BOTS_CONFIG env var).
function startFromConfig (cfg) {
  target = cfg.target || null
  startFollow = cfg.follow || null
  if (cfg.killMessage) killMessage = cfg.killMessage
  if (cfg.coords) startCoords = cfg.coords
  const names = [...new Set(cfg.names)].slice(0, MAX_BOTS)
  console.log(`Starting ${names.join(', ')}` +
    (target ? `, hunting ${target}` : '') +
    (startFollow ? `, following ${startFollow}` : '') +
    (startCoords ? `, heading to ${startCoords.x} ${startCoords.y} ${startCoords.z}` : ''))
  names.forEach(makeBot)
}

async function main () {
  if (process.env.BOTS_CONFIG) return startFromConfig(JSON.parse(process.env.BOTS_CONFIG))

  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout })
  const ask = q => new Promise(resolve => rl.question(q, a => resolve(a.trim())))

  console.log('\n=== Bot setup ===  (the server IP was asked just above, before the proxy started)\n')

  // Step 1 — names: auto-number from a base, or type them in.
  let picked = null
  const nameMode = await ask('1) Names — (a) auto-number from a base like bot1, bot2, or (t) type each name? (a / t): ')
  if (/^t/i.test(nameMode)) {
    while (!picked || picked.error) {
      if (picked) console.log('   ' + picked.error)
      picked = parseNames(await ask('   Type the names, space-separated (Bob Alex Max): '))
    }
    if (picked.prefix) picked = { names: [picked.prefix] }  // one typed word = that exact name
  } else {
    let base = null
    while (!base || base.error || base.names) {
      if (base && base.error) console.log('   ' + base.error)
      base = parseNames(await ask('   Base name? (Enter for "bot"): '))
    }
    picked = { prefix: base.prefix }
  }

  // Step 2 — how many (only meaningful when auto-numbering), capped so this stays a visit.
  let count = picked.names ? picked.names.length : 3
  if (picked.prefix) {
    count = Math.max(1, parseInt(await ask(`2) How many bots? (1-${MAX_BOTS}, Enter for 3): `), 10) || 3)
    if (count > MAX_BOTS) { console.log(`   Capping at ${MAX_BOTS} — more than that floods the server.`); count = MAX_BOTS }
  }

  // Step 3 — follow a player, fight a player, or neither.
  const mode = await ask('3) Follow a player, kill a player, or none? (f / k / n): ')
  let who = null
  if (/^f/i.test(mode)) {
    startFollow = await ask('   Follow which player? ') || null
  } else if (/^k/i.test(mode)) {
    who = await ask('   Kill which player? ') || null
    if (who) {
      const message = await ask(`   Kill message? {target} = who died, {bot} = bot name (Enter for "${killMessage}"): `)
      if (message) killMessage = message
    }
  }

  rl.close()
  start(count, who, picked)
}

main()
