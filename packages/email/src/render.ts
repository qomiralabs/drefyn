import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emailError } from './errors.ts';
import { checkMessage } from './guards.ts';
import { MailDocument } from './html/document.tsx';
import { placeholderContent } from './templates/placeholder.ts';
import { renderText } from './text.ts';
import type { EmailError, MailMessage, RenderedMail, Result } from './types.ts';

// React cannot write a doctype. XHTML Transitional keeps clients in almost standards
// mode, which table layouts rely on, and keeps the markup as it was before the swap.
const DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

// Rendering is synchronous; the promise stays so callers do not change if a template ever
// needs to load something.
export function renderMail(
  message: MailMessage,
  ctx: { readonly linkOrigin: URL },
): Promise<Result<RenderedMail, EmailError>> {
  return Promise.resolve(renderNow(message, ctx));
}

// Never throws: anything unexpected comes back as render_failed with nothing from the
// message in it.
function renderNow(
  message: MailMessage,
  ctx: { readonly linkOrigin: URL },
): Result<RenderedMail, EmailError> {
  try {
    const checked = checkMessage(message, ctx.linkOrigin);
    if (!checked.ok) return checked;
    const clean = checked.value;
    const content = placeholderContent(clean);
    const html = DOCTYPE + renderToStaticMarkup(createElement(MailDocument, { content }));
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
