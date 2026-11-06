import type { MdxRoot } from '@drefyn/mdx';

// Docs pages and rich text are stored as the MDX tree itself, so a save needs no conversion and
// untouched blocks keep their bytes. Studio and Status shapes join this union with their types.
export type NodeContent = MdxRoot;

// Read off the content and not from the running code: a version row has to say which shape its
// tree really has, and that is what a later migration selects on.
export const astVersionOf = (content: NodeContent): number => content.astVersion;
