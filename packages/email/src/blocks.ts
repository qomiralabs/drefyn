// What a template produces. Both parts are drawn from the same blocks, so the wording
// is written once and the code always gets a line of its own.
export type Block =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'code'; readonly code: string }
  | { readonly type: 'action'; readonly label: string; readonly href: URL }
  | {
      readonly type: 'facts';
      readonly rows: readonly { readonly label: string; readonly value: string }[];
    }
  | { readonly type: 'rule' }
  | { readonly type: 'fineprint'; readonly text: string };

export interface MailContent {
  readonly subject: string;
  readonly preheader: string;
  readonly blocks: readonly Block[];
}
