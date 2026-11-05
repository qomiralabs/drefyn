// Holds on to memory until the heap cap ends the thread.
const held: string[][] = [];
for (;;) held.push(Array.from({ length: 100_000 }, (_, index) => `${index}${held.length}`));
