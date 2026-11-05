import { expect, request } from '@playwright/test';

const API = `http://127.0.0.1:${process.env['DREFYN_MAILPIT_WEB_PORT'] ?? '58025'}/api/v1`;

interface Summary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Created: string;
}

async function api(path: string): Promise<unknown> {
  const context = await request.newContext();
  try {
    return await (await context.get(`${API}/${path}`)).json();
  } finally {
    await context.dispose();
  }
}

async function messagesTo(address: string): Promise<readonly Summary[]> {
  const query = new URLSearchParams({ query: `to:"${address}"` });
  const body = (await api(`search?${query.toString()}`)) as { messages: readonly Summary[] };
  return body.messages;
}

export async function countTo(address: string): Promise<number> {
  return (await messagesTo(address)).length;
}

// A sign in from a browser the person has not used. The subject is the one place the mail
// says which notice it is.
export async function newDeviceNotices(address: string): Promise<number> {
  const query = new URLSearchParams({ query: `to:"${address}" subject:"New sign in"` });
  const body = (await api(`search?${query.toString()}`)) as { messages: readonly Summary[] };
  return body.messages.length;
}

async function textOf(id: string): Promise<string> {
  return ((await api(`message/${id}`)) as { Text: string }).Text;
}

export interface SignInMail {
  readonly code: string;
  readonly link: string;
}

// The newest mail past `seen`, polled because mail goes out after the response.
export async function nextMail(address: string, seen: number): Promise<SignInMail> {
  let text = '';
  await expect
    .poll(async () => {
      const found = await messagesTo(address);
      if (found.length <= seen) return false;
      const newest = found[0];
      if (newest === undefined) return false;
      text = await textOf(newest.ID);
      return true;
    })
    .toBe(true);
  const code = /\b(\d{4}) ?(\d{4})\b/.exec(text);
  const link = /https?:\/\/\S+#\S+/.exec(text);
  if (code === null || link === null) throw new Error('no code or link in the mail');
  return { code: `${code[1] ?? ''}${code[2] ?? ''}`, link: link[0] };
}
