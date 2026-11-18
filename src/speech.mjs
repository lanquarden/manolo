export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 60;
export const MAX_SPEECH_TEXT = 1000;
const SPEECH_TIMEOUT_MS = 24_000;

export const validVoiceFileId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(id);
export const validTranscript = text => typeof text === 'string' && text.length <= 4000 && !!text.trim();
export const speechError = (message, permanent = false) => Object.assign(new Error(message), { permanent });
export const boundedSpeechText = text => text.slice(0, MAX_SPEECH_TEXT).replace(/[\uD800-\uDBFF]$/u, '');

export async function readBounded(response, max, signal) {
  if (!response.body || Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => {});
    throw speechError('Invalid or oversized audio response', true);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw speechError('Oversized audio response', true);
      chunks.push(value);
    }
    complete = true;
  } catch (error) {
    if (error?.permanent === true) throw error;
    throw speechError('Could not read audio response');
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) throw speechError('Empty audio response', true);
  return Buffer.concat(chunks, size);
}

// The Telegram transport uses a local voice service only by explicit configuration.
// URLs come from operator configuration, never from update, agent, or IQ payloads.
export function createSpeechFromEnv(env, fetchImpl = fetch) {
  const stt = env.MANOLO_STT_BASE_URL;
  const tts = env.MANOLO_TTS_BASE_URL;
  if (!stt && !tts) return undefined;
  const endpoint = (base, method) => {
    const url = URL.parse(base ?? '');
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Configure fixed HTTP(S) STT and TTS base URLs');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}/audio/${method}`;
  };
  const sttUrl = endpoint(stt, 'transcriptions');
  const ttsUrl = endpoint(tts, 'speech');
  const sttModel = env.MANOLO_STT_MODEL || 'qwen3-asr-1.7b';
  const ttsModel = env.MANOLO_TTS_MODEL || 'qwen3-tts-1.7b';
  const voice = env.MANOLO_TTS_VOICE || 'jarvis';
  const sttKey = env.MANOLO_STT_API_KEY;
  const ttsKey = env.MANOLO_TTS_API_KEY;

  async function request(url, key, body, max, callerSignal, json) {
    const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(url, { method: 'POST', body, redirect: 'error', signal,
        headers: { ...(key && { authorization: `Bearer ${key}` }), ...(json && { 'content-type': 'application/json' }) } });
      signal.throwIfAborted();
    } catch {
      throw speechError('Speech service request failed');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw speechError('Speech service rejected request', response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status));
    }
    return readBounded(response, max, signal);
  }

  return {
    async transcribe(audio, signal) {
      if (!audio?.byteLength || audio.byteLength > MAX_VOICE_BYTES) throw speechError('Invalid audio size', true);
      const form = new FormData();
      form.set('model', sttModel);
      form.set('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
      const response = await request(sttUrl, sttKey, form, 32 * 1024, signal);
      let text;
      try { ({ text } = JSON.parse(response.toString('utf8'))); } catch { throw speechError('Invalid transcription response'); }
      if (!validTranscript(text)) throw speechError('Invalid transcription', true);
      return text.trim();
    },
    async synthesize(text, signal) {
      const input = typeof text === 'string' && boundedSpeechText(text);
      if (!input || !input.trim()) throw speechError('Invalid speech input', true);
      const body = JSON.stringify({ model: ttsModel, voice, input, response_format: 'opus' });
      const audio = await request(ttsUrl, ttsKey, body, MAX_VOICE_BYTES, signal, true);
      if (audio.subarray(0, 4).toString('ascii') !== 'OggS' || audio.subarray(28, 36).toString('ascii') !== 'OpusHead') {
        throw speechError('Speech service did not return Ogg Opus', true);
      }
      return audio;
    },
  };
}
