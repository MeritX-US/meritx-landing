import type { AiConfig } from '../config';

/**
 * Paid-API AI path, provider-configurable (AI_PROVIDER=gemini|openai|anthropic|none).
 *
 * Data-minimising rules (pilot item #4):
 *  - Files are sent INLINE (base64) in the request. No vendor Files API, vector
 *    stores, assistants/threads, batches, or caching resources are ever created,
 *    so nothing persists at the vendor beyond its request/abuse-monitoring logs.
 *  - OpenAI: store=false on every request.
 *  - No prompts are hard-coded: system/user templates come from AI_PROMPTS_FILE (untracked).
 *  - Keys come from env; prompts/outputs are never logged.
 * Whether the account is actually on a paid, no-training, minimal/zero-retention
 * tier must be verified by a human: see docs/AI_VENDOR_VERIFICATION.md.
 */

export interface AiAttachment { mimeType: string; data: Buffer; filename: string }
export interface AiRequest { system: string; prompt: string; attachments?: AiAttachment[] }
export interface AiResult { text: string; provider: string; model: string; requestId: string | null }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; json(): Promise<any> }>;

export class AiDisabledError extends Error { constructor() { super('AI provider is disabled (AI_PROVIDER=none)'); } }
export class AiProviderError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Inline types each provider accepts. Anything else is skipped (lawyer reviews it manually). */
const INLINE = {
  gemini: new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']),
  openai: new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']),
  anthropic: new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']),
};

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in vars ? vars[k] : ''));
}

export class AiClient {
  constructor(private cfg: AiConfig, private fetchImpl: FetchLike = (globalThis.fetch as any)) {}

  get enabled() { return this.cfg.provider !== 'none'; }
  get label() { return `${this.cfg.provider}:${this.cfg.model || '-'}`; }

  /** Attachments that will be sent vs skipped, without sending anything. */
  partition(atts: AiAttachment[] = []) {
    if (this.cfg.provider === 'none') return { send: [], skipped: atts };
    const ok = INLINE[this.cfg.provider];
    return { send: atts.filter(a => ok.has(a.mimeType)), skipped: atts.filter(a => !ok.has(a.mimeType)) };
  }

  async generate(req: AiRequest): Promise<AiResult> {
    if (!this.enabled) throw new AiDisabledError();
    const { send } = this.partition(req.attachments);
    const textAtts = send.filter(a => a.mimeType === 'text/plain');
    const binAtts = send.filter(a => a.mimeType !== 'text/plain');
    const prompt = req.prompt + textAtts.map(a => `\n\n--- Attached document: ${a.filename} ---\n${a.data.toString('utf8')}`).join('');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      switch (this.cfg.provider) {
        case 'gemini': return await this.gemini(req.system, prompt, binAtts, ctrl.signal);
        case 'openai': return await this.openai(req.system, prompt, binAtts, ctrl.signal);
        case 'anthropic': return await this.anthropic(req.system, prompt, binAtts, ctrl.signal);
      }
    } finally {
      clearTimeout(timer);
    }
    throw new AiDisabledError();
  }

  private async post(url: string, headers: Record<string, string>, body: any, signal: AbortSignal) {
    const r = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new AiProviderError(r.status, `AI provider returned HTTP ${r.status}`); // never echo body (may contain input)
    return { json: await r.json(), headers: r.headers };
  }

  // Gemini API (paid tier = Cloud project with active billing). generateContent with inline_data; never the Files API.
  private async gemini(system: string, prompt: string, atts: AiAttachment[], signal: AbortSignal): Promise<AiResult> {
    const base = this.cfg.baseUrl || 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [...atts.map(a => ({ inline_data: { mime_type: a.mimeType, data: a.data.toString('base64') } })), { text: prompt }] }],
      generationConfig: { maxOutputTokens: this.cfg.maxOutputTokens },
    };
    const { json } = await this.post(url, { 'x-goog-api-key': this.cfg.apiKey }, body, signal);
    const text = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
    return { text, provider: 'gemini', model: this.cfg.model, requestId: json?.responseId || null };
  }

  // OpenAI Chat Completions with inline file/image parts and store=false.
  private async openai(system: string, prompt: string, atts: AiAttachment[], signal: AbortSignal): Promise<AiResult> {
    const base = this.cfg.baseUrl || 'https://api.openai.com';
    const parts: any[] = atts.map(a => a.mimeType === 'application/pdf'
      ? { type: 'file', file: { filename: a.filename, file_data: `data:${a.mimeType};base64,${a.data.toString('base64')}` } }
      : { type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.data.toString('base64')}` } });
    const body = {
      model: this.cfg.model,
      store: false,
      max_completion_tokens: this.cfg.maxOutputTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: [...parts, { type: 'text', text: prompt }] }],
    };
    const { json, headers } = await this.post(`${base}/v1/chat/completions`, { authorization: `Bearer ${this.cfg.apiKey}` }, body, signal);
    return { text: json?.choices?.[0]?.message?.content || '', provider: 'openai', model: this.cfg.model, requestId: headers.get('x-request-id') || json?.id || null };
  }

  // Anthropic Messages API with base64 document/image blocks (no Files API).
  private async anthropic(system: string, prompt: string, atts: AiAttachment[], signal: AbortSignal): Promise<AiResult> {
    const base = this.cfg.baseUrl || 'https://api.anthropic.com';
    const blocks: any[] = atts.map(a => ({
      type: a.mimeType === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: a.mimeType, data: a.data.toString('base64') },
    }));
    const body = { model: this.cfg.model, max_tokens: this.cfg.maxOutputTokens, system, messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }] };
    const { json, headers } = await this.post(`${base}/v1/messages`, { 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' }, body, signal);
    const text = (json?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return { text, provider: 'anthropic', model: this.cfg.model, requestId: headers.get('request-id') || json?.id || null };
  }
}
