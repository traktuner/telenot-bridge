/** Address of the state 'disarmed' of area 1 on a complex 400H. */
export const DEFAULT_AREA_STATE_ADDRESS = 0x530

/**
 * Returns the panel address of the state 'disarmed' of area 1.
 * The states of area n follow at `address + 8 * (n - 1)`:
 * +0 disarmed, +1 internally armed, +2 externally armed, +3 alarm or reset.
 * complex 400H: 0x530 (default). hiplex 8400H: 0x500 (see HIPLEX-8400H.md).
 * @param {Object} config - The bridge configuration.
 * @returns {number} The address.
 */
export function getAreaStateAddress(config) {
    const address = Number(config?.Telenot?.AREA_STATE_ADDRESS)
    return Number.isInteger(address) && address >= 8 && address <= 0xffff
        ? address
        : DEFAULT_AREA_STATE_ADDRESS
}

/**
 * Returns an address as four lower-case hex digits, as it appears in a frame.
 * @param {number} address - The panel address.
 * @returns {string} For example '0531'.
 */
export function toFrameHex(address) {
    return address.toString(16).padStart(4, '0')
}
