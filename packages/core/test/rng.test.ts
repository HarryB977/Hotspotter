import { expect, test } from 'vitest';
import { createRng } from '../src/rng';

test('same seed gives same sequence', () => {
  const a = createRng(42), b = createRng(42);
  expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
});
test('different seeds differ', () => expect(createRng(1).next()).not.toBe(createRng(2).next()));
test('int is inclusive and in range', () => {
  const r = createRng(7);
  const vals = Array.from({ length: 1000 }, () => r.int(0, 3));
  expect(new Set(vals)).toEqual(new Set([0, 1, 2, 3]));
});
test('pick returns an element of the array', () => {
  const r = createRng(3);
  const arr = ['a', 'b', 'c'] as const;
  for (let i = 0; i < 50; i++) expect(arr).toContain(r.pick(arr));
});
