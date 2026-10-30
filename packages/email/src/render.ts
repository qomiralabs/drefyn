import { render } from '@react-email/render';
import { createElement } from 'react';
import { emailError } from './errors.ts';
import { checkMessage } from './guards.ts';
import { MailDocument } from './html/document.tsx';
import { placeholderContent } from './templates/placeholder.ts';
import { renderText } from './text.ts';
import type { EmailError, MailMessage, RenderedMail, Result } from './types.ts';

// Async because the React Email renderer streams. Never throws: anything unexpected
// comes back as render_failed with nothing from the message in it.
export async function renderMail(
  message: MailMessage,
  ctx: { readonly linkOrigin: URL },
): Promise<Result<RenderedMail, EmailError>> {
  try {
    const checked = checkMessage(message, ctx.linkOrigin);
    if (!checked.ok) return checked;
    const clean = checked.value;
    const content = placeholderContent(clean);
    const html = await render(createElement(MailDocument, { content }));
    const value: RenderedMail = Object.freeze({
      template: clean.template,
      ...(clean.template === 'sign_in_code' ? { purpose: clean.purpose } : {}),
      ...(clean.template === 'security_notice' ? { noticeKind: clean.notice.kind } : {}),
      subject: content.subject,
      preheader: content.preheader,
      html,
      text: renderText(content),
    });
    return { ok: true, value };
  } catch {
    return { ok: false, error: emailError('email.render_failed') };
  }
}
