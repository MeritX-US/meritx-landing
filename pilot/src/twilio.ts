import { AUDIO_LIMIT } from './caseTools';

export interface TwilioConfig { account: string; key: string; secret: string; from: string; lawyerPhone: string }
export const phoneNumber = /^\+[1-9]\d{7,14}$/;

export class TwilioVoice {
  private base: string;
  private auth: string;

  constructor(private config: TwilioConfig, private fetchImpl: typeof fetch = fetch) {
    this.base = 'https://api.twilio.com/2010-04-01/Accounts/' + config.account;
    this.auth = 'Basic ' + Buffer.from(config.key + ':' + config.secret).toString('base64');
  }

  private async request(path: string, body?: URLSearchParams) {
    const response = await this.fetchImpl(this.base + path, {
      headers: { authorization: this.auth },
      ...(body ? { method: 'POST', body } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Voice provider request failed');
    return response;
  }

  async call(client: string) {
    if (!phoneNumber.test(client)) throw new Error('Invalid phone number');
    const twiml = '<Response><Say>Connecting your recorded consultation.</Say>' +
      '<Dial record="record-from-answer-dual" timeout="25" timeLimit="1800" callerId="' + this.config.from + '">' +
      client + '</Dial><Hangup/></Response>';
    const response = await this.request('/Calls.json', new URLSearchParams({
      To: this.config.lawyerPhone, From: this.config.from, Twiml: twiml, Timeout: '25',
    }));
    const result = await response.json() as { sid?: string };
    if (!result.sid || !/^CA[a-f0-9]{32}$/i.test(result.sid)) throw new Error('Invalid call response');
    return result.sid;
  }

  async recording(call: string) {
    if (!/^CA[a-f0-9]{32}$/i.test(call)) throw new Error('Invalid call');
    const response = await this.request('/Calls/' + call + '/Recordings.json');
    const { recordings } = await response.json() as { recordings: { sid: string; status: string; call_sid: string }[] };
    const recording = recordings.find(entry => entry.status === 'completed' && entry.call_sid === call && /^RE[a-f0-9]{32}$/i.test(entry.sid));
    if (!recording) return null;
    const media = await this.request('/Recordings/' + recording.sid + '.mp3');
    if (!media.body) throw new Error('Recording has no audio');
    const reader = media.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > AUDIO_LIMIT) throw new Error('Recording exceeds size limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
}
