// What a template produces. Both parts are drawn from the same blocks, so the wording
// is written once and the code always gets a line of its own.
export interface FactRow {
  readonly label: string;
  readonly value: string;
}

export type Block =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'code'; readonly code: string; readonly note: string }
  | {
      readonly type: 'action';
      readonly label: string;
      readonly href: URL;
      readonly note?: string;
      // Set small, so a mail with a second link still has one main action.
      readonly quiet?: boolean;
    }
  | { readonly type: 'facts'; readonly rows: readonly FactRow[] }
  | { readonly type: 'rule' }
  | { readonly type: 'fineprint'; readonly text: string };

export interface MailContent {
  readonly subject: string;
  readonly preheader: string;
  // What the mail is, set in the running head.
  readonly folio: string;
  readonly sender: string;
  readonly blocks: readonly Block[];
}
