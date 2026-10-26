import { describe, expect, it } from 'vitest';
import { composite, contrast, floor2 } from '../src/tokens/contrast.ts';
import { tokens } from '../src/tokens/tokens.ts';
import {
  aliasRoles,
  colorOf,
  decorativeRoles,
  disabledCeiling,
  disabledPairs,
  expandPairs,
  fillBackdrops,
  fillFloor,
  forbiddenPairs,
  measure,
  minimum,
  requiredPairs,
  ruledOutPairs,
  supplementaryMarks,
} from '../src/tokens/pairs.ts';

// Every required pair with the ratio it measures today, floored to two decimals. A token change
// that moves a ratio fails here until the table is updated, so the numbers in review are the
// numbers users see. Text needs 4.5:1, marks and control borders need 3:1.
const required = [
  // Light, text
  ['light', 'text.ink', 'surface.ground', 'text', 18.02],
  ['light', 'text.ink', 'surface.raised', 'text', 17.26],
  ['light', 'text.ink', 'surface.sunken', 'text', 17.26],
  ['light', 'text.body', 'surface.ground', 'text', 14.0],
  ['light', 'text.body', 'surface.raised', 'text', 13.4],
  ['light', 'text.body', 'surface.sunken', 'text', 13.4],
  ['light', 'text.secondary', 'surface.ground', 'text', 7.25],
  ['light', 'text.secondary', 'surface.raised', 'text', 6.94],
  ['light', 'text.secondary', 'surface.sunken', 'text', 6.94],
  ['light', 'text.subtle', 'surface.ground', 'text', 4.55],
  ['light', 'accent.ink', 'surface.ground', 'text', 6.02],
  ['light', 'accent.ink', 'surface.raised', 'text', 5.76],
  ['light', 'accent.ink', 'surface.sunken', 'text', 5.76],
  ['light', 'accent.press', 'surface.ground', 'text', 7.56],
  ['light', 'accent.press', 'surface.raised', 'text', 7.24],
  ['light', 'accent.press', 'surface.sunken', 'text', 7.24],
  ['light', 'signal.text', 'surface.ground', 'text', 5.24],
  ['light', 'signal.text', 'surface.raised', 'text', 5.01],
  ['light', 'signal.text', 'surface.sunken', 'text', 5.01],
  ['light', 'state.fresh.text', 'surface.ground', 'text', 4.8],
  ['light', 'state.fresh.text', 'surface.raised', 'text', 4.59],
  ['light', 'state.fresh.text', 'surface.sunken', 'text', 4.59],
  ['light', 'state.stale.text', 'surface.ground', 'text', 4.8],
  ['light', 'state.stale.text', 'surface.raised', 'text', 4.6],
  ['light', 'state.stale.text', 'surface.sunken', 'text', 4.6],
  ['light', 'state.broken.text', 'surface.ground', 'text', 6.19],
  ['light', 'state.broken.text', 'surface.raised', 'text', 5.93],
  ['light', 'state.broken.text', 'surface.sunken', 'text', 5.93],
  ['light', 'state.neutral.text', 'surface.ground', 'text', 7.25],
  ['light', 'state.neutral.text', 'surface.raised', 'text', 6.94],
  ['light', 'state.neutral.text', 'surface.sunken', 'text', 6.94],
  ['light', 'accent.on', 'accent.ink', 'text', 6.28],
  ['light', 'accent.on', 'accent.press', 'text', 7.9],
  // Light, marks and controls
  ['light', 'border.control', 'surface.ground', 'non-text', 3.3],
  ['light', 'border.control', 'surface.raised', 'non-text', 3.16],
  ['light', 'border.control', 'surface.sunken', 'non-text', 3.16],
  ['light', 'focus.ring', 'surface.ground', 'non-text', 6.02],
  ['light', 'focus.ring', 'surface.raised', 'non-text', 5.76],
  ['light', 'focus.ring', 'surface.sunken', 'non-text', 5.76],
  ['light', 'state.fresh.mark', 'surface.ground', 'non-text', 3.15],
  ['light', 'state.fresh.mark', 'surface.raised', 'non-text', 3.02],
  ['light', 'state.fresh.mark', 'surface.sunken', 'non-text', 3.02],
  ['light', 'state.broken.mark', 'surface.ground', 'non-text', 4.62],
  ['light', 'state.broken.mark', 'surface.raised', 'non-text', 4.42],
  ['light', 'state.broken.mark', 'surface.sunken', 'non-text', 4.42],
  ['light', 'state.neutral.text', 'state.neutral.mark', 'non-text', 5.08],
  // Light, on the selection wash over each surface
  ['light', 'text.ink', 'accent.wash@ground', 'text', 16.05],
  ['light', 'text.ink', 'accent.wash@raised', 'text', 15.38],
  ['light', 'text.ink', 'accent.wash@sunken', 'text', 15.38],
  ['light', 'text.body', 'accent.wash@ground', 'text', 12.47],
  ['light', 'text.body', 'accent.wash@raised', 'text', 11.95],
  ['light', 'text.body', 'accent.wash@sunken', 'text', 11.95],
  ['light', 'text.secondary', 'accent.wash@ground', 'text', 6.46],
  ['light', 'text.secondary', 'accent.wash@raised', 'text', 6.19],
  ['light', 'text.secondary', 'accent.wash@sunken', 'text', 6.19],
  ['light', 'accent.ink', 'accent.wash@ground', 'text', 5.36],
  ['light', 'accent.ink', 'accent.wash@raised', 'text', 5.13],
  ['light', 'accent.ink', 'accent.wash@sunken', 'text', 5.13],
  ['light', 'focus.ring', 'accent.wash@ground', 'non-text', 5.36],
  ['light', 'focus.ring', 'accent.wash@raised', 'non-text', 5.13],
  ['light', 'focus.ring', 'accent.wash@sunken', 'non-text', 5.13],
  // Light, the selection indicator bar, on the wash and on each surface
  ['light', 'accent.ink', 'accent.wash@ground', 'non-text', 5.36],
  ['light', 'accent.ink', 'accent.wash@raised', 'non-text', 5.13],
  ['light', 'accent.ink', 'accent.wash@sunken', 'non-text', 5.13],
  ['light', 'accent.ink', 'surface.ground', 'non-text', 6.02],
  ['light', 'accent.ink', 'surface.raised', 'non-text', 5.76],
  ['light', 'accent.ink', 'surface.sunken', 'non-text', 5.76],
  // Light, on the hover fill
  ['light', 'text.ink', 'surface.hover', 'text', 16.53],
  ['light', 'text.body', 'surface.hover', 'text', 12.84],
  ['light', 'text.secondary', 'surface.hover', 'text', 6.65],
  ['light', 'accent.ink', 'surface.hover', 'text', 5.52],
  ['light', 'accent.press', 'surface.hover', 'text', 6.93],
  ['light', 'state.broken.text', 'surface.hover', 'text', 5.68],
  ['light', 'state.neutral.text', 'surface.hover', 'text', 6.65],
  ['light', 'border.control', 'surface.hover', 'non-text', 3.03],
  ['light', 'focus.ring', 'surface.hover', 'non-text', 5.52],
  // Light, on the pressed fill
  ['light', 'text.ink', 'surface.pressed', 'text', 15.54],
  ['light', 'text.body', 'surface.pressed', 'text', 12.08],
  ['light', 'text.secondary', 'surface.pressed', 'text', 6.25],
  ['light', 'accent.ink', 'surface.pressed', 'text', 5.19],
  ['light', 'focus.ring', 'surface.pressed', 'non-text', 5.19],
  // Dark, text
  ['dark', 'text.ink', 'surface.ground', 'text', 17.89],
  ['dark', 'text.ink', 'surface.raised', 'text', 16.62],
  ['dark', 'text.ink', 'surface.sunken', 'text', 15.34],
  ['dark', 'text.body', 'surface.ground', 'text', 12.54],
  ['dark', 'text.body', 'surface.raised', 'text', 11.65],
  ['dark', 'text.body', 'surface.sunken', 'text', 10.75],
  ['dark', 'text.secondary', 'surface.ground', 'text', 7.4],
  ['dark', 'text.secondary', 'surface.raised', 'text', 6.88],
  ['dark', 'text.secondary', 'surface.sunken', 'text', 6.35],
  ['dark', 'text.subtle', 'surface.ground', 'text', 7.4],
  ['dark', 'text.subtle', 'surface.raised', 'text', 6.88],
  ['dark', 'text.subtle', 'surface.sunken', 'text', 6.35],
  ['dark', 'accent.ink', 'surface.ground', 'text', 6.26],
  ['dark', 'accent.ink', 'surface.raised', 'text', 5.82],
  ['dark', 'accent.ink', 'surface.sunken', 'text', 5.37],
  ['dark', 'accent.press', 'surface.ground', 'text', 9.37],
  ['dark', 'accent.press', 'surface.raised', 'text', 8.7],
  ['dark', 'accent.press', 'surface.sunken', 'text', 8.03],
  ['dark', 'signal.text', 'surface.ground', 'text', 7.5],
  ['dark', 'signal.text', 'surface.raised', 'text', 6.97],
  ['dark', 'signal.text', 'surface.sunken', 'text', 6.43],
  ['dark', 'state.fresh.text', 'surface.ground', 'text', 10.72],
  ['dark', 'state.fresh.text', 'surface.raised', 'text', 9.96],
  ['dark', 'state.fresh.text', 'surface.sunken', 'text', 9.19],
  ['dark', 'state.stale.text', 'surface.ground', 'text', 11.19],
  ['dark', 'state.stale.text', 'surface.raised', 'text', 10.4],
  ['dark', 'state.stale.text', 'surface.sunken', 'text', 9.6],
  ['dark', 'state.broken.text', 'surface.ground', 'text', 6.75],
  ['dark', 'state.broken.text', 'surface.raised', 'text', 6.27],
  ['dark', 'state.broken.text', 'surface.sunken', 'text', 5.79],
  ['dark', 'state.neutral.text', 'surface.ground', 'text', 7.4],
  ['dark', 'state.neutral.text', 'surface.raised', 'text', 6.88],
  ['dark', 'state.neutral.text', 'surface.sunken', 'text', 6.35],
  ['dark', 'accent.on', 'accent.ink', 'text', 6.26],
  ['dark', 'accent.on', 'accent.press', 'text', 9.37],
  // Dark, marks and controls
  ['dark', 'border.control', 'surface.ground', 'non-text', 3.89],
  ['dark', 'border.control', 'surface.raised', 'non-text', 3.61],
  ['dark', 'border.control', 'surface.sunken', 'non-text', 3.34],
  ['dark', 'focus.ring', 'surface.ground', 'non-text', 6.26],
  ['dark', 'focus.ring', 'surface.raised', 'non-text', 5.82],
  ['dark', 'focus.ring', 'surface.sunken', 'non-text', 5.37],
  ['dark', 'signal.mark', 'surface.ground', 'non-text', 7.5],
  ['dark', 'signal.mark', 'surface.raised', 'non-text', 6.97],
  ['dark', 'signal.mark', 'surface.sunken', 'non-text', 6.43],
  ['dark', 'state.fresh.mark', 'surface.ground', 'non-text', 10.72],
  ['dark', 'state.fresh.mark', 'surface.raised', 'non-text', 9.96],
  ['dark', 'state.fresh.mark', 'surface.sunken', 'non-text', 9.19],
  ['dark', 'state.stale.mark', 'surface.ground', 'non-text', 11.19],
  ['dark', 'state.stale.mark', 'surface.raised', 'non-text', 10.4],
  ['dark', 'state.stale.mark', 'surface.sunken', 'non-text', 9.6],
  ['dark', 'state.broken.mark', 'surface.ground', 'non-text', 6.75],
  ['dark', 'state.broken.mark', 'surface.raised', 'non-text', 6.27],
  ['dark', 'state.broken.mark', 'surface.sunken', 'non-text', 5.79],
  ['dark', 'state.neutral.text', 'state.neutral.mark', 'non-text', 4.07],
  // Dark, on the selection wash over each surface
  ['dark', 'text.ink', 'accent.wash@ground', 'text', 15.79],
  ['dark', 'text.ink', 'accent.wash@raised', 'text', 14.5],
  ['dark', 'text.ink', 'accent.wash@sunken', 'text', 13.23],
  ['dark', 'text.body', 'accent.wash@ground', 'text', 11.07],
  ['dark', 'text.body', 'accent.wash@raised', 'text', 10.16],
  ['dark', 'text.body', 'accent.wash@sunken', 'text', 9.27],
  ['dark', 'text.secondary', 'accent.wash@ground', 'text', 6.53],
  ['dark', 'text.secondary', 'accent.wash@raised', 'text', 6],
  ['dark', 'text.secondary', 'accent.wash@sunken', 'text', 5.47],
  ['dark', 'accent.ink', 'accent.wash@ground', 'text', 5.52],
  ['dark', 'accent.ink', 'accent.wash@raised', 'text', 5.07],
  ['dark', 'accent.ink', 'accent.wash@sunken', 'text', 4.63],
  ['dark', 'focus.ring', 'accent.wash@ground', 'non-text', 5.52],
  ['dark', 'focus.ring', 'accent.wash@raised', 'non-text', 5.07],
  ['dark', 'focus.ring', 'accent.wash@sunken', 'non-text', 4.63],
  // Dark, the selection indicator bar, on the wash and on each surface
  ['dark', 'accent.ink', 'accent.wash@ground', 'non-text', 5.52],
  ['dark', 'accent.ink', 'accent.wash@raised', 'non-text', 5.07],
  ['dark', 'accent.ink', 'accent.wash@sunken', 'non-text', 4.63],
  ['dark', 'accent.ink', 'surface.ground', 'non-text', 6.26],
  ['dark', 'accent.ink', 'surface.raised', 'non-text', 5.82],
  ['dark', 'accent.ink', 'surface.sunken', 'non-text', 5.37],
  // Dark, on the hover fill
  ['dark', 'text.ink', 'surface.hover', 'text', 14.96],
  ['dark', 'text.body', 'surface.hover', 'text', 10.49],
  ['dark', 'text.secondary', 'surface.hover', 'text', 6.19],
  ['dark', 'accent.ink', 'surface.hover', 'text', 5.23],
  ['dark', 'accent.press', 'surface.hover', 'text', 7.83],
  ['dark', 'signal.text', 'surface.hover', 'text', 6.27],
  ['dark', 'state.broken.text', 'surface.hover', 'text', 5.64],
  ['dark', 'state.neutral.text', 'surface.hover', 'text', 6.19],
  ['dark', 'border.control', 'surface.hover', 'non-text', 3.25],
  ['dark', 'focus.ring', 'surface.hover', 'non-text', 5.23],
  // Dark, on the pressed fill
  ['dark', 'text.ink', 'surface.pressed', 'text', 13.62],
  ['dark', 'text.body', 'surface.pressed', 'text', 9.55],
  ['dark', 'text.secondary', 'surface.pressed', 'text', 5.64],
  ['dark', 'accent.ink', 'surface.pressed', 'text', 4.77],
  ['dark', 'focus.ring', 'surface.pressed', 'non-text', 4.77],
] as const;

// Rules that come out of the numbers. Each must keep failing, so nobody "fixes" the table by
// deleting the rule instead of changing how the colour is used.
const forbidden = [
  // Captions sit on ground only in light.
  ['light', 'text.subtle', 'surface.raised', 'text', 4.36],
  ['light', 'text.subtle', 'surface.sunken', 'text', 4.36],
  // Amber and teal marks never stand alone on paper; they sit beside a word or a tick.
  ['light', 'state.stale.mark', 'surface.ground', 'non-text', 2.05],
  ['light', 'signal.mark', 'surface.ground', 'non-text', 2.38],
  // State words and captions never sit on the selection wash, and selected rows draw their
  // edge from the rule token, not the control border.
  ['light', 'state.fresh.text', 'accent.wash@ground', 'text', 4.27],
  ['light', 'state.fresh.text', 'accent.wash@raised', 'text', 4.09],
  ['light', 'state.fresh.text', 'accent.wash@sunken', 'text', 4.09],
  ['light', 'state.stale.text', 'accent.wash@ground', 'text', 4.28],
  ['light', 'state.stale.text', 'accent.wash@raised', 'text', 4.1],
  ['light', 'state.stale.text', 'accent.wash@sunken', 'text', 4.1],
  ['light', 'text.subtle', 'accent.wash@ground', 'text', 4.05],
  ['light', 'text.subtle', 'accent.wash@raised', 'text', 3.88],
  ['light', 'text.subtle', 'accent.wash@sunken', 'text', 3.88],
  ['light', 'border.control', 'accent.wash@ground', 'non-text', 2.94],
  ['light', 'border.control', 'accent.wash@raised', 'non-text', 2.82],
  ['light', 'border.control', 'accent.wash@sunken', 'non-text', 2.82],
  ['dark', 'border.control', 'accent.wash@sunken', 'non-text', 2.88],
  // Green and amber words and captions miss 4.5 on the light fills, so anything that can be
  // hovered or pressed shows state with its icon and body text.
  ['light', 'state.fresh.text', 'surface.hover', 'text', 4.4],
  ['light', 'state.stale.text', 'surface.hover', 'text', 4.4],
  ['light', 'text.subtle', 'surface.hover', 'text', 4.17],
  ['light', 'state.fresh.text', 'surface.pressed', 'text', 4.14],
  ['light', 'state.stale.text', 'surface.pressed', 'text', 4.14],
  ['light', 'text.subtle', 'surface.pressed', 'text', 3.92],
  // A pressed element never draws a control edge.
  ['light', 'border.control', 'surface.pressed', 'non-text', 2.85],
  ['dark', 'border.control', 'surface.pressed', 'non-text', 2.96],
  // Disabled items never take the hover or pressed fill.
  ['light', 'disabled.text', 'surface.hover', 'text', 2.25],
  ['dark', 'disabled.text', 'surface.hover', 'text', 2.04],
  ['light', 'disabled.text', 'surface.pressed', 'text', 2.11],
  ['dark', 'disabled.text', 'surface.pressed', 'text', 1.86],
] as const;

// Ruled out by design even where the ratio passes, so the rule reads the same in both modes:
// a selected row shows state with its icon and ink text, never coloured text.
const ruledOut = [
  ['light', 'state.broken.text', 'accent.wash@ground', 'text', 5.51],
  ['light', 'state.broken.text', 'accent.wash@raised', 'text', 5.28],
  ['light', 'state.broken.text', 'accent.wash@sunken', 'text', 5.28],
  ['light', 'state.neutral.text', 'accent.wash@ground', 'text', 6.46],
  ['light', 'state.neutral.text', 'accent.wash@raised', 'text', 6.19],
  ['light', 'state.neutral.text', 'accent.wash@sunken', 'text', 6.19],
  ['dark', 'state.fresh.text', 'accent.wash@ground', 'text', 9.46],
  ['dark', 'state.fresh.text', 'accent.wash@raised', 'text', 8.69],
  ['dark', 'state.fresh.text', 'accent.wash@sunken', 'text', 7.93],
  ['dark', 'state.stale.text', 'accent.wash@ground', 'text', 9.87],
  ['dark', 'state.stale.text', 'accent.wash@raised', 'text', 9.07],
  ['dark', 'state.stale.text', 'accent.wash@sunken', 'text', 8.27],
  ['dark', 'state.broken.text', 'accent.wash@ground', 'text', 5.96],
  ['dark', 'state.broken.text', 'accent.wash@raised', 'text', 5.47],
  ['dark', 'state.broken.text', 'accent.wash@sunken', 'text', 4.99],
  ['dark', 'state.neutral.text', 'accent.wash@ground', 'text', 6.53],
  ['dark', 'state.neutral.text', 'accent.wash@raised', 'text', 6],
  ['dark', 'state.neutral.text', 'accent.wash@sunken', 'text', 5.47],
  ['dark', 'text.subtle', 'accent.wash@ground', 'text', 6.53],
  ['dark', 'text.subtle', 'accent.wash@raised', 'text', 6],
  ['dark', 'text.subtle', 'accent.wash@sunken', 'text', 5.47],
  ['dark', 'border.control', 'accent.wash@ground', 'non-text', 3.43],
  ['dark', 'border.control', 'accent.wash@raised', 'non-text', 3.15],
  // The same rule on the hover and pressed fills.
  ['dark', 'state.fresh.text', 'surface.hover', 'text', 8.96],
  ['dark', 'state.stale.text', 'surface.hover', 'text', 9.36],
  ['dark', 'text.subtle', 'surface.hover', 'text', 6.19],
  ['light', 'state.broken.text', 'surface.pressed', 'text', 5.34],
  ['light', 'state.neutral.text', 'surface.pressed', 'text', 6.25],
  ['dark', 'state.fresh.text', 'surface.pressed', 'text', 8.16],
  ['dark', 'state.stale.text', 'surface.pressed', 'text', 8.52],
  ['dark', 'state.broken.text', 'surface.pressed', 'text', 5.14],
  ['dark', 'state.neutral.text', 'surface.pressed', 'text', 5.64],
  ['dark', 'text.subtle', 'surface.pressed', 'text', 5.64],
] as const;

// Disabled controls are drawn with their own colours, never with opacity, so every value they
// show is measured here. Each sits inside a band: a label above its floor can still be made
// out, and nothing reaches 3:1, so a disabled control never reads as a live one. WCAG exempts
// disabled controls; the band is ours.
const disabled = [
  ['light', 'disabled.text', 'disabled.fill', 'text', 2.35],
  ['light', 'disabled.text', 'surface.ground', 'text', 2.45],
  ['light', 'disabled.text', 'surface.raised', 'text', 2.35],
  ['light', 'disabled.text', 'surface.sunken', 'text', 2.35],
  ['light', 'disabled.edge', 'disabled.fill', 'non-text', 1.36],
  ['light', 'disabled.edge', 'surface.ground', 'non-text', 1.42],
  ['light', 'disabled.edge', 'surface.raised', 'non-text', 1.36],
  ['light', 'disabled.edge', 'surface.sunken', 'non-text', 1.36],
  ['dark', 'disabled.text', 'disabled.fill', 'text', 2.27],
  ['dark', 'disabled.text', 'surface.ground', 'text', 2.44],
  ['dark', 'disabled.text', 'surface.raised', 'text', 2.27],
  ['dark', 'disabled.text', 'surface.sunken', 'text', 2.1],
  ['dark', 'disabled.edge', 'disabled.fill', 'non-text', 1.69],
  ['dark', 'disabled.edge', 'surface.ground', 'non-text', 1.81],
  ['dark', 'disabled.edge', 'surface.raised', 'non-text', 1.69],
  ['dark', 'disabled.edge', 'surface.sunken', 'non-text', 1.56],
] as const;

// State icons beside a state word on a hovered or pressed item. The word, in body text, carries
// the meaning, so the icon is supplementary and no 3:1 minimum applies. Pinned so a change to a
// mark or a fill is still seen in review.
const supplementary = [
  ['light', 'state.fresh.mark', 'surface.hover', 'non-text', 2.89],
  ['light', 'state.stale.mark', 'surface.hover', 'non-text', 1.88],
  ['light', 'state.broken.mark', 'surface.hover', 'non-text', 4.24],
  ['light', 'state.neutral.mark', 'surface.hover', 'non-text', 1.3],
  ['light', 'state.fresh.mark', 'surface.pressed', 'non-text', 2.72],
  ['light', 'state.stale.mark', 'surface.pressed', 'non-text', 1.77],
  ['light', 'state.broken.mark', 'surface.pressed', 'non-text', 3.98],
  ['light', 'state.neutral.mark', 'surface.pressed', 'non-text', 1.23],
  ['dark', 'state.fresh.mark', 'surface.hover', 'non-text', 8.96],
  ['dark', 'state.stale.mark', 'surface.hover', 'non-text', 9.36],
  ['dark', 'state.broken.mark', 'surface.hover', 'non-text', 5.64],
  ['dark', 'state.neutral.mark', 'surface.hover', 'non-text', 1.52],
  ['dark', 'state.fresh.mark', 'surface.pressed', 'non-text', 8.16],
  ['dark', 'state.stale.mark', 'surface.pressed', 'non-text', 8.52],
  ['dark', 'state.broken.mark', 'surface.pressed', 'non-text', 5.14],
  ['dark', 'state.neutral.mark', 'surface.pressed', 'non-text', 1.38],
] as const;

const key = (row: readonly unknown[]) => row.slice(0, 4).join(' ');

describe('required contrast pairs', () => {
  it.each(required)('%s %s on %s (%s) measures %s', (mode, fg, bg, kind, ratio) => {
    const measured = measure({ fg, bg, kind }, mode);
    expect(measured).toBe(ratio);
    expect(measured).toBeGreaterThanOrEqual(minimum[kind]);
  });

  it('lists exactly the pairs the tokens declare, so none go unmeasured', () => {
    const declared = expandPairs(requiredPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.sort()).toEqual(required.map(key).sort());
  });
});

describe('forbidden contrast pairs', () => {
  it.each(forbidden)('%s %s on %s (%s) still fails at %s', (mode, fg, bg, kind, ratio) => {
    const measured = measure({ fg, bg, kind }, mode);
    expect(measured).toBe(ratio);
    expect(measured).toBeLessThan(minimum[kind]);
  });

  it('lists exactly the forbidden pairs the tokens declare', () => {
    const declared = expandPairs(forbiddenPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(declared.sort()).toEqual(forbidden.map(key).sort());
  });
});

describe('ruled out pairs', () => {
  it.each(ruledOut)(
    '%s %s on %s (%s) measures %s but is never used',
    (mode, fg, bg, kind, ratio) => {
      expect(measure({ fg, bg, kind }, mode)).toBe(ratio);
    },
  );

  it('lists exactly the ruled out pairs the tokens declare', () => {
    const declared = expandPairs(ruledOutPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(declared.sort()).toEqual(ruledOut.map(key).sort());
  });

  it('never overlaps the required pairs', () => {
    const required = new Set(expandPairs(requiredPairs).map((p) => key([p.mode, p.fg, p.bg])));
    const others = [...forbiddenPairs, ...ruledOutPairs, ...disabledPairs, ...supplementaryMarks];
    for (const p of expandPairs(others)) {
      expect(required.has(key([p.mode, p.fg, p.bg])), key([p.mode, p.fg, p.bg])).toBe(false);
    }
  });
});

describe('supplementary state marks', () => {
  it.each(supplementary)(
    '%s %s on %s (%s) measures %s, beside a state word',
    (mode, fg, bg, kind, ratio) => {
      expect(measure({ fg, bg, kind }, mode)).toBe(ratio);
    },
  );

  it('lists exactly the supplementary marks the tokens declare', () => {
    const declared = expandPairs(supplementaryMarks).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(declared.sort()).toEqual(supplementary.map(key).sort());
  });

  it('always has a body text word that passes on the same fill', () => {
    const required = new Set(expandPairs(requiredPairs).map((p) => key([p.mode, p.fg, p.bg])));
    for (const p of expandPairs(supplementaryMarks)) {
      expect(required.has(key([p.mode, 'text.body', p.bg])), key([p.mode, p.bg])).toBe(true);
    }
  });
});

describe('disabled pairs', () => {
  const floorOf = (mode: string, fg: string, bg: string) => {
    const group = disabledPairs.find(
      (g) =>
        g.modes.some((m) => m === mode) && g.fg.some((f) => f === fg) && g.bg.some((b) => b === bg),
    );
    if (group === undefined) throw new Error(`${mode} ${fg} on ${bg} is not declared`);
    return group.floor;
  };

  it.each(disabled)(
    '%s %s on %s (%s) measures %s, inside the band',
    (mode, fg, bg, kind, ratio) => {
      const measured = measure({ fg, bg, kind }, mode);
      expect(measured).toBe(ratio);
      expect(measured).toBeGreaterThanOrEqual(floorOf(mode, fg, bg));
      expect(measured).toBeLessThan(disabledCeiling);
    },
  );

  it('lists exactly the disabled pairs the tokens declare', () => {
    const declared = expandPairs(disabledPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.sort()).toEqual(disabled.map(key).sort());
  });

  it('keeps the ceiling at the live floor for marks and control edges', () => {
    expect(disabledCeiling).toBe(minimum['non-text']);
  });

  it('keeps a label floor that can still be made out', () => {
    for (const g of disabledPairs) {
      if (g.kind === 'text') expect(g.floor).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads weaker than the live control it stands in for, on every surface', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const bg of ['surface.ground', 'surface.raised', 'surface.sunken'] as const) {
        expect(measure({ fg: 'disabled.text', bg }, mode)).toBeLessThan(
          measure({ fg: 'text.secondary', bg }, mode),
        );
        expect(measure({ fg: 'disabled.edge', bg }, mode)).toBeLessThan(
          measure({ fg: 'border.control', bg }, mode),
        );
      }
    }
  });

  it('never appears in a live pair', () => {
    for (const p of expandPairs(requiredPairs)) {
      expect(p.fg.startsWith('disabled.'), key([p.mode, p.fg, p.bg])).toBe(false);
      expect(p.bg.startsWith('disabled.'), key([p.mode, p.fg, p.bg])).toBe(false);
    }
  });
});

describe('colorOf', () => {
  it('composites the wash over the surface it lands on, in the same mode', () => {
    expect(colorOf('accent.wash@ground', 'light')).toBe('#ECECF7');
    expect(colorOf('accent.wash@sunken', 'light')).toBe('#E8E7F3');
    expect(colorOf('accent.wash@ground', 'dark')).toBe('#1F1E27');
    expect(colorOf('accent.wash@raised', 'dark')).toBe('#26252E');
    expect(colorOf('accent.wash@sunken', 'dark')).toBe('#2D2C33');
  });

  it('reads a role for the mode', () => {
    expect(colorOf('surface.ground', 'dark')).toBe('#141210');
    expect(colorOf('state.broken.text', 'light')).toBe('#B91C1C');
  });
});

describe('coverage', () => {
  const roles: string[] = [];
  const walk = (node: object, path: string[]) => {
    for (const [key, child] of Object.entries(node)) {
      if (typeof (child as { light?: unknown }).light === 'string') {
        roles.push([...path, key].join('.'));
      } else walk(child as object, [...path, key]);
    }
  };
  walk(tokens.color, []);

  it('measures every colour role somewhere, or lists it as decorative with a reason', () => {
    const groups = [...requiredPairs, ...forbiddenPairs, ...ruledOutPairs, ...disabledPairs];
    const used = new Set(groups.flatMap((g) => [...g.fg, ...g.bg]));
    const decorative = new Set(decorativeRoles.map((d) => d.role));
    // An alias is measured through the roles it resolves to, which must themselves be covered.
    // Required pairs only: a role that only appears in forbidden or ruled out pairs has no
    // approved text on it, so an alias of it would be covered by nothing.
    const measured = new Set(expandPairs(requiredPairs).flatMap((p) => [p.fg, p.bg]));
    const aliased = new Set(
      aliasRoles
        .filter((a) => (['light', 'dark'] as const).every((m) => measured.has(a.resolves[m])))
        .map((a) => a.role),
    );
    for (const role of roles) {
      const covered = used.has(role as never) || decorative.has(role as never);
      expect(covered || aliased.has(role as never), role).toBe(true);
    }
    for (const d of decorativeRoles) {
      expect(roles, d.role).toContain(d.role);
      expect(d.why.length, d.role).toBeGreaterThan(10);
    }
  });

  it('writes every colour as six digit upper case hex, which the generator assumes', () => {
    const hexes: string[] = [tokens.wash.light.base, tokens.wash.dark.base];
    const walkHex = (node: object) => {
      for (const child of Object.values(node)) {
        if (typeof child === 'string') hexes.push(child);
        else walkHex(child as object);
      }
    };
    walkHex(tokens.color);
    for (const hex of hexes) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('keeps the selection wash visible on every surface it lands on', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const s of ['ground', 'raised', 'sunken'] as const) {
        const off = floor2(
          contrast(colorOf(`accent.wash@${s}`, mode), colorOf(`surface.${s}`, mode)),
        );
        expect(off, `${mode} ${s}`).toBeGreaterThanOrEqual(1.1);
      }
    }
  });

  // Light raised is only 1.04 off the hover fill, which is why floating things sit on ground
  // in light. Ground, raised and the overlay clear the floor in both modes; sunken does not in
  // dark (1.02), so interactive items never sit on sunken, in either mode.
  it('keeps the hover and pressed fills visible on the surfaces they may land on', () => {
    const off = (fill: 'surface.hover' | 'surface.pressed', mode: 'light' | 'dark', bg: string) =>
      floor2(contrast(colorOf(fill, mode), colorOf(bg as 'surface.ground', mode)));
    expect([
      off('surface.hover', 'light', 'surface.ground'),
      off('surface.hover', 'light', 'surface.raised'),
    ]).toEqual([1.09, 1.04]);
    expect([
      off('surface.hover', 'dark', 'surface.ground'),
      off('surface.hover', 'dark', 'surface.raised'),
    ]).toEqual([1.19, 1.11]);
    expect(fillFloor).toBe(1.04);
    expect(fillBackdrops.allowed).toEqual(['surface.ground', 'surface.raised', 'surface.overlay']);
    for (const mode of ['light', 'dark'] as const) {
      for (const bg of fillBackdrops.allowed) {
        for (const fill of ['surface.hover', 'surface.pressed'] as const) {
          expect(off(fill, mode, bg), `${mode} ${fill} on ${bg}`).toBeGreaterThanOrEqual(fillFloor);
        }
      }
      expect(
        off('surface.hover', mode, 'surface.overlay'),
        `${mode} overlay`,
      ).toBeGreaterThanOrEqual(1.09);
    }
  });

  it('keeps interactive items off sunken, where the hover fill disappears in dark', () => {
    const off = (mode: 'light' | 'dark') =>
      floor2(contrast(colorOf('surface.hover', mode), colorOf('surface.sunken', mode)));
    expect(fillBackdrops.never).toEqual(['surface.sunken']);
    expect([off('light'), off('dark')]).toEqual([1.04, 1.02]);
    // Dark fails the floor outright. Light only meets it because sunken and raised share a hex
    // there; the rule holds in both modes so it reads the same wherever someone builds.
    expect(off('dark')).toBeLessThan(fillFloor);
    for (const bg of fillBackdrops.never) {
      expect(fillBackdrops.allowed as readonly string[]).not.toContain(bg);
    }
    expect(fillBackdrops.why.length).toBeGreaterThan(10);
  });

  it('keeps the pressed fill a step past the hover fill', () => {
    const step = (mode: 'light' | 'dark', bg: 'surface.ground' | 'surface.hover') =>
      floor2(contrast(colorOf('surface.pressed', mode), colorOf(bg, mode)));
    expect([step('light', 'surface.ground'), step('dark', 'surface.ground')]).toEqual([1.15, 1.31]);
    expect([step('light', 'surface.hover'), step('dark', 'surface.hover')]).toEqual([1.06, 1.09]);
  });
});

describe('aliases', () => {
  it('puts floating things on ground in light and on raised in dark', () => {
    expect(colorOf('surface.overlay', 'light')).toBe(tokens.color.surface.ground.light);
    expect(colorOf('surface.overlay', 'dark')).toBe(tokens.color.surface.raised.dark);
  });

  it('draws skeletons in the rule colour, which never carries text', () => {
    expect(tokens.color.skeleton.fill).toEqual(tokens.color.border.rule);
    expect(decorativeRoles.map((d) => d.role)).toContain('skeleton.fill');
  });

  it('declares each alias with the roles it resolves to, in both modes', () => {
    expect(aliasRoles.map((a) => a.role)).toEqual(['surface.overlay']);
    for (const a of aliasRoles) {
      for (const mode of ['light', 'dark'] as const) {
        expect(colorOf(a.role, mode), `${a.role} ${mode}`).toBe(colorOf(a.resolves[mode], mode));
      }
      expect(a.why.length, a.role).toBeGreaterThan(10);
    }
  });
});

// The scrim is translucent and only ever lies over the page, so the numbers that matter are
// the dialog against the dimmed page and, in dark, the edge that carries the dialog.
describe('modal scrim', () => {
  const dimmed = (mode: 'light' | 'dark') => {
    const { base, alpha } = tokens.overlay.scrim[mode];
    return composite(base, alpha, tokens.color.surface.ground[mode]);
  };

  it('is ink at 24 percent in light and black at half in dark, with no blur', () => {
    expect(tokens.overlay.scrim.light).toEqual({ base: tokens.color.text.ink.light, alpha: 0.24 });
    expect(tokens.overlay.scrim.dark).toEqual({ base: '#000000', alpha: 0.5 });
  });

  it('sets the dialog off the dimmed page', () => {
    const lift = (mode: 'light' | 'dark') =>
      floor2(contrast(colorOf('surface.overlay', mode), dimmed(mode)));
    expect(lift('light')).toBe(1.7);
    expect(lift('dark')).toBe(1.14);
  });

  it('lets the strong rule carry the dialog edge in dark', () => {
    const edge = floor2(contrast(tokens.color.border.ruleStrong.dark, dimmed('dark')));
    expect(edge).toBe(1.93);
    expect(edge).toBeGreaterThan(
      floor2(contrast(colorOf('surface.overlay', 'dark'), dimmed('dark'))),
    );
  });
});
