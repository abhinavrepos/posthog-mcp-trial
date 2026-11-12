/** Deliberately sensitive-looking, synthetic values used only by the replay lab. */
export const CANARIES = {
    notional: '7,314,159.26',
    cash: 'CAD 2,718,281',
    rate: '4.6692%',
    counterparty: 'Zanthor Capital',
    tradeId: 'TRD-90210-77',
} as const
export const canaryStrings = Object.values(CANARIES)
