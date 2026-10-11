// Requirement sets per delivery phase (SPEC §16.6), used by `pnpm trace -- --phase <P>` and the gates.
const ids = (prefix: string, ...nums: number[]): string[] => nums.map((n) => `FR-${prefix}-${String(n).padStart(2, '0')}`);

const P3 = [...ids('ORG', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), ...ids('MRG', 1, 2, 3, 4, 5, 6), ...ids('OPT', 2, 3, 4, 6), ...ids('APP', 4, 5, 6, 11, 12, 13), ...ids('SEC', 4, 5), ...ids('VIEW', 11)];
const P4 = [...ids('ANN', 1, 2, 3, 4, 6, 7, 8, 9, 11), ...ids('STM', 2, 3, 5, 6, 7, 8), ...ids('FRM', 1, 2, 3, 5, 6, 7, 9), ...ids('EDT', 1, 2, 3, 4, 5, 6, 7, 8), ...ids('VIEW', 1, 3, 4, 5)];
const P5 = [...ids('APP', 10), ...ids('STM', 1, 10), ...ids('AIF', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), ...ids('FRM', 10)];
const P6 = [...ids('APP', 1, 2, 3, 7, 9), ...ids('VIEW', 2, 6, 7, 8, 9), ...ids('STM', 9, 12)];

export const PHASES: Record<string, string[]> = {
  P2: [...ids('VIEW', 1, 3, 4)],
  P3,
  P4,
  P5,
  P6,
  P7: [...P3, ...P4, ...P5, ...P6],
};
