# Telenot Bridge

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/traktuner/telenot-bridge)](https://github.com/traktuner/telenot-bridge/releases)
[![CI](https://github.com/traktuner/telenot-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/traktuner/telenot-bridge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/traktuner/telenot-bridge/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/traktuner/telenot-bridge/actions/workflows/codeql-analysis.yml)
[![Docker image](https://github.com/traktuner/telenot-bridge/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/traktuner/telenot-bridge/actions/workflows/docker-publish.yml)

A Node.js bridge between a **Telenot** alarm panel, **MQTT**, **Home Assistant** and **HomeKit**.
The bridge reads the RS232 interface of the panel through a serial-to-Ethernet adapter. It
publishes detectors and the alarm state to MQTT and can send arm and disarm commands.

It is not a replacement for the Telenot KNX interface. It does not have the same features and it
is not VdS certified. Use it at your own risk.

## About this fork

This repository is a fork of [carhensi/telenot-bridge](https://github.com/carhensi/telenot-bridge).
Carsten Hensiek wrote the bridge. His work builds on the application of
[Michel Munzert](https://github.com/michelde). This fork adds support for the **hiplex 8400H**
and makes the bridge more robust. The image is `ghcr.io/traktuner/telenot-bridge`.

| Panel                | State                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Telenot complex 400H | Original target of the bridge. Not tested in this fork.                                  |
| Telenot hiplex 8400H | Detectors, area state, disarm and internal arming verified on one installation (one area). |

Changes in this fork:

- The alarm state follows positions with a `role`, not fixed topic names.
- The panel connection reconnects without a limit and keeps its data handlers.
- The container health check fails when the panel sends no data for 120 seconds.
- All states are published again after an MQTT reconnect.
- `LOGLEVEL` is applied. The default is `info`.
- `AREA_STATE_ADDRESS` sets the area address for other panels (commands and event frames).
- `COMMANDS_ENABLED=false` refuses every command to the panel.
- The bridge publishes the Home Assistant alarm panel entity itself (`ALARM_PANEL_DISCOVERY=true`).
  It offers only the modes in `ALARM_PANEL_FEATURES` and a button that resets the panel after an alarm.
- `ALARM_CODE`: the bridge checks the disarm code. The code is not part of a retained MQTT payload.
- `ARM_HOME_DELAY`: exit delay in seconds before an internal arm command is sent. The state is `arming`.
- Entities become unavailable in Home Assistant when the bridge is offline.
- A position can set `device_class` (or `null`) and `icon` for Home Assistant.
- A position with `switch: true` becomes a Home Assistant switch (detector area switched off).
- Discovery mode (`DISCOVER=true`) logs every changed bit.

The measured positions and frames of the hiplex 8400H are in [HIPLEX-8400H.md](HIPLEX-8400H.md).
The open points and past mistakes are in [PROJECT-TRAPS.md](PROJECT-TRAPS.md).

## Features

- Arm home (`arm_home`), arm away (`arm_away`) and a virtual arm night (`arm_night`) for automations
- Home Assistant MQTT discovery for detectors, the alarm panel, a reset button and switches
- MQTT topics for every configured position
- Command check: disarm code, exit delay, switch to turn all commands off
- Log levels, discovery mode and a diagnostics topic for commands
- Jest tests, including a replay of real frames

## Hardware

You need an RS232-to-Ethernet adapter and a straight-through RS232 cable, for example the
USR-TCP232-302 Tiny. The bridge connects to the adapter with a TCP socket.

Set the serial parameters of the adapter to what the panel uses: 9600 bit/s, 8 data bits, no parity,
1 stop bit. In the panel parameters, set the RS232 port to GMS output. For commands, the installer
must also permit switching through the serial interface.

## Configuration

The container reads its settings from environment variables. The detector list is a configuration
directory that you mount into the container.

1. Copy the example configuration and edit it for your panel:

    ```bash
    cp -r src/config-example config
    ```

    The detector positions depend on the panel type and on your installation. See the
    [configuration guide](src/config-example/README.md) and [HIPLEX-8400H.md](HIPLEX-8400H.md).
    The example files are generic. Do not publish the real detector list of a house.

2. Set the environment variables. The most important ones:

    | Variable                                         | Meaning                                                                    |
    | ------------------------------------------------ | -------------------------------------------------------------------------- |
    | `MQTTHOST`, `MQTTPORT`, `MQTTUSER`, `MQTTPASSWORD` | MQTT broker, for example `mqtt://broker`, `1883`                           |
    | `TELNETHOST`, `TELNETPORT`                       | Address and port of the serial-to-Ethernet adapter                         |
    | `PUBLISHTOPIC`, `STATETOPIC`, `COMMANDTOPIC`     | MQTT topics. Defaults: `telenot/alarm`, `telenot/alarm/state`, `telenot/alarm/command` |
    | `USE_JSON_PAYLOAD`                               | `true`: command payload is JSON (needed for `ALARM_CODE`)                  |
    | `HOMEASSISTANT_AUTODISCOVERY`                    | `true`: publish Home Assistant discovery topics                            |
    | `AREA_STATE_ADDRESS`                             | Area address in hex. complex 400H: `530` (default). hiplex 8400H: `500`    |
    | `COMMANDS_ENABLED`                               | `false`: refuse every command to the panel. Default: `true`                |
    | `ALARM_PANEL_DISCOVERY`                          | `true`: the bridge publishes the alarm panel entity                        |
    | `ALARM_PANEL_FEATURES`                           | Modes in Home Assistant. Default: `arm_home,arm_away,arm_night`            |
    | `ALARM_PANEL_NAME`, `ALARM_PANEL_DEVICE_NAME`, `ALARM_PANEL_DEVICE_MODEL` | Names in Home Assistant                                   |
    | `ALARM_CODE`                                     | Code for `DISARM`. The bridge checks it. Keep it in a secret store         |
    | `ARM_HOME_DELAY`                                 | Exit delay in seconds before internal arming. Default: `0`                 |
    | `ALARM_RESET_BUTTON`                             | `false`: no reset button. Default: `true`                                  |
    | `DISCOVER`                                       | `true`: log every changed bit (discovery mode)                             |
    | `LOGLEVEL`                                       | `error`, `warn`, `info`, `discover`, `verbose` or `debug`. Default: `info`|
    | `HEARTBEAT_FILE`, `HEARTBEAT_MAX_AGE`            | Health check: file and maximum age in seconds                              |

    `ALARM_PANEL_DISCOVERY` needs `HOMEASSISTANT_AUTODISCOVERY=true`.

## Usage

```bash
docker run -d --name telenot-bridge \
   --restart unless-stopped \
   --env-file .env \
   -v "$(pwd)/config:/app/src/config:ro" \
   ghcr.io/traktuner/telenot-bridge:latest
```

For a production system, use a version tag (for example `0.3.0`) or the image digest, not `latest`.
The repository contains a [docker-compose.yaml](docker-compose.yaml) as a starting point.

### Safety notes

- Everybody who can publish to the command topic can arm and disarm the panel. Restrict the MQTT
  access of that topic.
- Set `ALARM_CODE` and `COMMANDS_ENABLED` deliberately. With `COMMANDS_ENABLED=false` the bridge
  only reads.
- The panel refuses to arm while a detector of the area is open. A switch for a detector area makes
  the panel ignore that detector. It needs no code.
- Test every command with a person at the keypad of the panel. Do not trigger an alarm for a test.

## Home Assistant and HomeKit

See [homeassistant/README.md](homeassistant/README.md). With `ALARM_PANEL_DISCOVERY=true` the alarm
panel entity comes from the bridge and needs no manual MQTT configuration. The dashboard example
needs the HACS cards that the guide lists.

## Releases and updates

- Every push to `main` publishes `latest` and `sha-<commit>`. A tag `vX.Y.Z` publishes `X.Y.Z`.
- On the first day of every month, a workflow rebuilds the image from `main` without a cache. The
  newest base image and the newest operating system packages go into it. The workflow creates the
  next patch tag (for example `0.3.1`) and a GitHub release. It runs only when the tests pass.
- [Renovate](https://docs.renovatebot.com/) updates the dependencies and the GitHub Actions. It
  merges minor, patch and digest updates by itself 14 days after their release when the CI is green.
  A major update needs a manual review.

## Development

```bash
git clone https://github.com/traktuner/telenot-bridge.git
cd telenot-bridge
cp -r src/config-example src/config   # the tests import src/config (ignored by git)
yarn install                          # Yarn 1.22 (yarn.lock is a Yarn 1 file)
yarn test
yarn test:coverage
```

Open an issue or a pull request for changes. Do not put credentials or the detector list of a real
installation into the repository.

## License

This project is licensed under the [Apache License 2.0](LICENSE). The original author changed the
license from ISC to Apache 2.0 in the commit "fix(license): correct license type from ISC to Apache 2.0".
The changes of this fork (see [About this fork](#about-this-fork)) are under the same license.

## Acknowledgements

- [Carsten Hensiek](https://github.com/carhensi), author of the original bridge
- [Michel Munzert](https://github.com/michelde) for the application that inspired it
- Telenot for the alarm systems, and the Home Assistant community
