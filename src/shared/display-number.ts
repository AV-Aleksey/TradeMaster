import Decimal from 'decimal.js';

/** Presentation only; signal calculations keep their original decimal values. */
export function displayNumber(value: string, decimalPlaces = 6): string {
  try {
    const number = new Decimal(value);
    if (!number.isFinite()) return value;
    const rounded = number.toDecimalPlaces(decimalPlaces);
    const text = !number.isZero() && rounded.isZero() ? number.toSignificantDigits(6).toString() : rounded.toFixed();
    return text.replace('.', ',');
  } catch { return value; }
}

export function indicatorDecimalPlaces(label: string): number {
  return /stoch|стохаст/iu.test(label) ? 2 : 6;
}
