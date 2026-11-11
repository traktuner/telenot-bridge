# Telenot hiplex 8400H

The bridge was written for the complex 400H. A hiplex 8400H sends the same two
frame types, but the bit positions are different. This page lists what was
measured on one hiplex 8400H installation. Verify each position on your own
panel before you rely on it.

Status: the positions of the detectors and of the area state come from
bridge logs compared with the installer parameter list, and from tests at the
panel. Disarm and internal arming from Home Assistant work.

## How a position maps to a panel address

A position in `locations/*.mjs` is a bit index: `byte = position div 8`,
`bit = position mod 8`, least significant bit first. `inverted: true` means
that bit `0` is the active state. This is the normal case for Telenot.

| Config block                | Frame                                   | Rule                                         |
| --------------------------- | --------------------------------------- | -------------------------------------------- |
| `MELDEGRUPPEN` (offset 12)  | `68 LL LL 68 73 02 XX 24 00 00 00 01 …` | position = bit index in the data             |
| `MELDEBEREICHE` (offset 10) | `68 LL LL 68 73 02 XX 24 00 05 00 02 …` | panel address = `0x0500 + (position - 0x10)` |

The offset 10 of `MELDEBEREICHE` includes two header bytes. That is why
position `0x10` is the first data bit (address `0x0500`).

## Detectors (`MELDEGRUPPEN`)

On the measured panel the position follows the Meldebereich number of the
installer list (section "Meldebereiche"):

```
position = 0x00F + Meldebereich number
```

MB 1 is `0x010`, MB 2 is `0x011`, MB 20 is `0x023`. The order of the panel
inputs does not matter; the Meldebereich number does.

## Area state (`MELDEBEREICHE`)

| State               | complex 400H | hiplex 8400H | Evidence on the hiplex                      |
| ------------------- | ------------ | ------------ | ------------------------------------------- |
| Unscharf (disarmed) | `0x40`       | `0x10`       | changes with each arm and disarm            |
| Intern scharf       | `0x41`       | `0x11`       | changes with each internal arming           |
| Extern scharf       | `0x42`       | `0x12`       | by analogy, not observed                    |
| Alarm               | `0x43`       | `0x13`       | active during a real alarm, until the reset |
| Störung             | `0x44`       | `0x14`       | by analogy, not observed                    |
| Intern bereit       | `0x45`       | `0x15`       | changes often                               |
| Extern bereit       | `0x46`       | `0x16`       | changes often                               |

The complex 400H reports area 1 at address `0x0530`, the measured hiplex at
`0x0500`. The pattern of the seven bits is the same.

Give the positions a `role`, so that the bridge derives the alarm state from
them (see [Alarm state](#alarm-state)):

```js
{ hex: '0x11', name: 'Intern scharf', /* … */ inverted: true, role: 'armed_home' },
{ hex: '0x12', name: 'Extern scharf', /* … */ inverted: true, role: 'armed_away' },
{ hex: '0x13', name: 'Alarm',         /* … */ inverted: true, role: 'triggered' },
```

Other observations, not needed for the configuration:

- Positions `0x0C8` and above (address `0x05B8` and above): "Meldebereich switched
  off" flags, see below.
- The block at `0x120` (address `0x0610`) repeats the area pattern.

## Alarm state

The bridge publishes `disarmed`, `armed_home`, `armed_away` or `triggered` to
the state topic. It derives the state from the positions that have a `role`.
Priority: `triggered`, `armed_away`, `armed_home`, else `disarmed`.

If no position has a role, the bridge uses the topics that end with
`/extern_scharf` and `/intern_scharf`.

The event frames that the complex 400H sends for arming and disarming contain
the area address. The bridge builds the patterns from `AREA_STATE_ADDRESS`.
It is not verified that a hiplex sends these frames in the same format.
The state bits are the reliable source of the alarm state on a hiplex.

## Commands (verified for disarm and internal arming)

A command frame addresses the area state: `AREA_STATE_ADDRESS + 8 * (area - 1)`,
plus 0 for disarm, 1 for internal arming, 2 for external arming, 3 for reset.

- complex 400H: `AREA_STATE_ADDRESS = 0x530` (default).
- hiplex 8400H: `0x500`. Set the environment variable `AREA_STATE_ADDRESS=500`.

Measured on a hiplex 8400H: the frame `68090968730105020005010262e516`
armed internally and `680909687301050200050002E16316` disarmed. The state bits
changed 1.3 s and 2.5 s after the command. External arming and reset are not tested.

Preconditions that the bridge cannot check:

- The installer must permit switching through the serial interface in the
  panel parameters. Without that permission the panel ignores the frame.
- The panel refuses to arm while a detector of the area is open.

The bridge publishes the result of each command to
`<publish topic>/diagnostics/command`. `sent` means that the frame was written
to the connection. Only a change of the state topic proves that the panel
executed the command.

### Exit delay and code

- `ARM_HOME_DELAY=30`: the bridge waits 30 s before it sends the internal arm
  frame. The state is `arming` during that time. `DISARM` cancels the wait.
- `ALARM_CODE=<code>`: `DISARM` needs this code. Home Assistant sends it with the
  command (`{"action":"DISARM","code":"…"}`); the bridge compares it. The code is
  not stored in a retained topic. Arming needs no code.

## Switch a detector area off and on

The panel has one flag for each Meldebereich: "switched off" (the detector is
ignored when the area is armed). On the measured hiplex 8400H:

```
position = 0x0C8 + (Meldebereich number - 1)      address = 0x05B8 + (number - 1)
```

MB 3 is position `0x0CA` (address `0x05BA`). Bit `0` means switched off.
The panel reports a change with an event frame that names the detector area:
`… 05 02 00 05 BA 02 51 …` (switched off) and `… 05 BA 02 D1 …` (switched on).

A position with `switch: true` becomes a Home Assistant switch. The bridge
reads the flag from the position and writes to `<position topic>/set`:

```js
{
    hex: '0xCA',
    name: 'MB 3 abgeschaltet',
    name_ha: 'Window bypassed',
    type: 'abschaltung',
    topic: 'telenot/alarm/room1/mb_3_abgeschaltet',
    location: 'Room 1',
    inverted: true,
    switch: true, // or { on_value: '51', off_value: 'd1' }
},
```

`ON` sends the value `51` to the address of the flag, `OFF` sends `d1`. The
command form is derived from the event frames and from the verified arm
command. **The switch command itself is not verified on a panel.** A switch in
Home Assistant needs no code: everybody who can use the switch can make the
panel ignore that detector.

## Frames of a hiplex 8400H

The panel sends a cycle of four frames about every 3 s. The bridge decodes two:

| Frame            | Example                                    | Decoded              |
| ---------------- | ------------------------------------------ | -------------------- |
| Detectors        | `68 LL LL 68 73 02 XX 24 00 00 00 01 …`    | yes, `MELDEGRUPPEN`  |
| Area state       | `68 LL LL 68 73 02 XX 24 00 05 00 02 …`    | yes, `MELDEBEREICHE` |
| Block `0e 08 00` | `68 LL LL 68 73 02 XX 0e 08 00 6e 00 00 …` | no                   |
| Block `0e 0a 00` | `68 LL LL 68 73 02 XX 0e 0a 00 6e 00 00 …` | no                   |

An arm or disarm produces one longer event frame with text
(`… 05 02 01 05 01 02 62 …` for internal arming). The complex 400H patterns
(a different length) do not match it. The bridge acknowledges it and uses the state bits.

The bridge expects one frame for each TCP segment. The panel waits for the
acknowledge before it sends the next frame, so this holds in practice.

## Find positions with discovery mode

Set `DISCOVER=true`. The bridge then logs each changed bit, also bits without
a configured position:

```
DISCOVERY: 2026-01-01T12:00:00.000Z | MELDEBEREICHE | 0x040 (dec:64) | Byte:8 Bit:0 | 1->0 | UNKNOWN
```

Change one state on the panel (open one window, arm, disarm) and read the line.
`1->0` is the change to the active state for an inverted position.
