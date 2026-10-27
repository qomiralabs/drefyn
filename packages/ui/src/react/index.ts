// The component entry. One named re-export per component file, never export *, so the
// split test can tell which file each export comes from. No 'use client' here: it would
// turn every server safe component into a client one for every importer.
export {};
