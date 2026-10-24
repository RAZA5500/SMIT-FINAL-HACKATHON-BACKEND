import { randomInt } from 'node:crypto';

export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/;
export const PASSWORD_RULE_MESSAGE =
  'Password must be 8-64 characters long and contain at least one letter and one number';

export const BCRYPT_ROUNDS = 10;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/** Cryptographically random temporary password that satisfies the password policy. */
export function generateTempPassword(length = 12): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
