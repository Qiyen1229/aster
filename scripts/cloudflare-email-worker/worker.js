/* global Response, fetch */
import PostalMime from 'postal-mime';

const RECIPIENT_RE = /^in-[a-f0-9]{20}@/i;
const MAX_TEXT_CHARS = 8000;

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatFrom(parsedFrom, fallback) {
  if (parsedFrom && parsedFrom.address) {
    return parsedFrom.name
      ? `${parsedFrom.name} <${parsedFrom.address}>`
      : parsedFrom.address;
  }
  return fallback || '';
}

export default {
  async email(message, env) {
    const to = (message.to || '').trim().toLowerCase();
    if (!RECIPIENT_RE.test(to)) {
      message.setReject('Unknown recipient');
      return;
    }

    const webhookUrl = (env.ASTER_WEBHOOK_URL || 'https://aster.qiyen.me/api/hook/email').trim();
    const webhookSecret = (env.ASTER_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) {
      throw new Error('ASTER_WEBHOOK_SECRET is not configured');
    }

    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(rawBuffer);

    const plain = (parsed.text || '').trim();
    const bodyText = (plain || stripHtml(parsed.html || '')).slice(0, MAX_TEXT_CHARS);
    const subject = (parsed.subject || message.headers.get('subject') || '').trim().slice(0, 300);
    const fromAddr = formatFrom(parsed.from, message.from).slice(0, 320);
    const messageId = (parsed.messageId || message.headers.get('message-id') || '').trim() || null;

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aster-Webhook-Secret': webhookSecret,
      },
      body: JSON.stringify({
        to,
        from_addr: fromAddr,
        subject,
        text: bodyText,
        message_id: messageId,
      }),
    });

    if (res.status === 404) {
      message.setReject('Recipient address is not active');
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Aster webhook failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  },
};
