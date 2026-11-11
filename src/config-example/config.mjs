import ema from './locations/ema.mjs'
import eg from './locations/eg.mjs'
import og from './locations/og.mjs'

const config = {
    LogLevel: process.env.LOGLEVEL || 'info',
    Connection: {
        mqttConfig: {
            broker: process.env.MQTTHOST || 'mqtt://localhost',
            port: parseInt(process.env.MQTTPORT, 10) || 1883,
            username: process.env.MQTTUSER || '',
            password: process.env.MQTTPASSWORD || '',
            publishTopic: process.env.PUBLISHTOPIC || 'telenot/alarm',
            commandTopic: process.env.COMMANDTOPIC || 'telenot/alarm/command',
            stateTopic: process.env.STATETOPIC || 'telenot/alarm/state',
            statusTopic: 'telenot/alarm/status',
            diagnosticsTopic: 'telenot/alarm/diagnostics',
            use_json_payload: process.env.USE_JSON_PAYLOAD === 'true',
        },
        telnetConfig: {
            host: process.env.TELNETHOST || 'localhost',
            port: parseInt(process.env.TELNETPORT, 10) || 1234,
        },
    },
    Discover: process.env.DISCOVER === 'true',
    homeassistant_autodiscovery: process.env.HOMEASSISTANT_AUTODISCOVERY === 'true',
    Telenot: {
        COMMAND_SB_STATE_ON: '680909687301050200',
        // Panel address of the state 'disarmed' of area 1 (hex in the environment).
        // complex 400H: 530 (default). hiplex 8400H: 500, see HIPLEX-8400H.md.
        // The command frames and the arm/disarm event frames use this address.
        AREA_STATE_ADDRESS: parseInt(process.env.AREA_STATE_ADDRESS, 16) || 0x530,
        // Set COMMANDS_ENABLED=false to refuse every command to the panel.
        COMMANDS_ENABLED: process.env.COMMANDS_ENABLED !== 'false',
        // Alarm panel entity in Home Assistant, published by the bridge when
        // ALARM_PANEL_DISCOVERY=true (it needs HOMEASSISTANT_AUTODISCOVERY=true too).
        ALARM_PANEL: {
            discovery: process.env.ALARM_PANEL_DISCOVERY === 'true',
            name: process.env.ALARM_PANEL_NAME || 'Alarmanlage',
            device_name: process.env.ALARM_PANEL_DEVICE_NAME || 'Telenot',
            device_model: process.env.ALARM_PANEL_DEVICE_MODEL || 'Telenot Alarm System',
            // Modes that Home Assistant offers: arm_home, arm_away, arm_night.
            features: (process.env.ALARM_PANEL_FEATURES || 'arm_home,arm_away,arm_night')
                .split(',')
                .map((feature) => feature.trim())
                .filter(Boolean),
            // Code for DISARM. The bridge checks it; it is not part of the discovery payload.
            code: process.env.ALARM_CODE || '',
            // Exit delay in seconds before an internal arm command is sent. 0 = at once.
            arm_home_delay: parseInt(process.env.ARM_HOME_DELAY, 10) || 0,
            // Button entity that sends RESET (reset the panel after an alarm).
            reset_button: process.env.ALARM_RESET_BUTTON !== 'false',
        },
        SICHERUNGSBEREICH: {
            name: 'SICHERUNGSBEREICH',
            offset: 10,
            positions: [...ema.sicherungsbereich],
        },
        SICHERUNGSBEREICH2: {
            name: 'SICHERUNGSBEREICH2',
            offset: 10,
            positions: [...ema.sicherungsbereich2],
        },
        MELDEBEREICHE: {
            name: 'MELDEBEREICHE',
            offset: 10,
            positions: [...ema.meldebereiche],
        },
        MELDEGRUPPEN: {
            name: 'MELDEGRUPPEN',
            offset: 12,
            positions: [...ema.meldegruppen, ...eg.meldegruppen, ...og.meldegruppen],
        },
    },
}

export default config
