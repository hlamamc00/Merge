import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const gen = customAlphabet(alphabet, 16);

export function newId(prefix: string): string {
  return `${prefix}_${gen()}`;
}
