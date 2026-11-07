# mcbots

Mineflayer bots for a Minecraft server **you own or have permission to use**.

An interactive launcher that connects one or more bots through a local
[ViaProxy](https://github.com/ViaVersion/ViaProxy) instance (so an older client
can talk to a newer server). The bots can follow or fight a named player, walk
to coordinates, and auto-accept `/tpa` requests.

## Use responsibly

Only connect these bots to a server you run, or a friend's server whose owner is
okay with them. Don't use them to flood, grief, or attack servers you don't
control — that gets you (and your IP) banned, and it's not what this is for. The
launcher caps the number of bots for that reason.

## Requirements

- Node.js 18+
- Java 21+ (for ViaProxy)
- `ViaProxy.jar` from the [ViaProxy releases](https://github.com/ViaVersion/ViaProxy/releases),
  placed in a `viaproxy/` folder next to these files.

## Setup

```sh
npm install
./start.sh
```

There is no built-in server address — `start.sh` asks for one every run and
remembers the last one locally (in `server.txt`, which is git-ignored).

## What it asks

1. Server address
2. Bot names — auto-numbered from a base (`bot1`, `bot2`, …) or typed in
3. How many bots (1–8)
4. Follow a player, fight a player, or none — and which player

## In-game chat commands

| Command | Effect |
| --- | --- |
| `bots follow [name]` | Follow you, or the named player |
| `bots kill <name>` | Fight the named player |
| `bots goto <x> <y> <z>` | Walk to coordinates |
| `bots come` | Send you a `/tpa` |
| `bots end` / `bots portal` | Walk into the nearest End / any portal |
| `bots stop` | Stop following/fighting |
| `bots leave` | Disconnect all bots |
