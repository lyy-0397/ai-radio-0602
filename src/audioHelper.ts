const VOICES = ["Aoede", "Kore", "Puck", "Charon", "Fenrir"] as const;
export type VoiceName = (typeof VOICES)[number];

export const parseScript = (script: string) => {
  const lines = script.split("\n").filter((l) => l.trim().length > 0);
  const characterLines: { speakers: string[]; text: string; fullLine: string }[] = [];
  const uniqueSpeakers = new Set<string>();

  for (const line of lines) {
    const match = line.match(/^([^：:]+)[：:](.+)$/);
    if (match) {
      let speakersStr = match[1].trim();
      const text = match[2].trim();
      
      // Attempt to parse things like "BC合" -> ["B", "C"]
      // If it contains "合", extract uppercase english letters or chinese characters beforehand?
      // A simple heuristic: if it ends with "合" and has multiple characters.
      let speakers: string[] = [speakersStr];
      if (speakersStr.endsWith("合")) {
         const chars = speakersStr.replace("合", "").split("");
         speakers = chars.map(c => c.trim()).filter(Boolean);
      }
      
      speakers.forEach(s => uniqueSpeakers.add(s));
      characterLines.push({ speakers, text, fullLine: line });
    } else {
      // If no speaker identified, maybe just narration or continuation?
      characterLines.push({ speakers: [], text: line.trim(), fullLine: line });
    }
  }

  return { characterLines, speakers: Array.from(uniqueSpeakers) };
};

export const fetchTTS = async (
  text: string, 
  voiceName: string, 
  customApiKey?: string, 
  baseUrl?: string,
  openRouterKey?: string,
  retries = 5
): Promise<ArrayBuffer> => {
  for (let i = 0; i < retries; i++) {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceName, customApiKey, baseUrl, openRouterKey }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errorMessage = typeof err.error === 'string' ? err.error : JSON.stringify(err.error) || "Failed to fetch TTS";
      
      const isRateLimit = res.status === 429 || errorMessage.includes("429") || errorMessage.includes("Quota") || errorMessage.includes("RESOURCE_EXHAUSTED");
      
      if (isRateLimit && i < retries - 1) {
         let delay = 10000 * Math.pow(1.5, i);
         const match = errorMessage.match(/retry in (\d+(?:\.\d+)?)s/);
         if (match) {
             delay = parseFloat(match[1]) * 1000 + 1000;
         }
         console.warn(`Rate limit hit, retrying in ${delay}ms...`);
         await new Promise(r => setTimeout(r, delay));
         continue;
      }
      
      if (isRateLimit) {
         throw new Error("API 频率超额 (429)。请在右上角设置中填入您自己的 Gemini API Key 获得更高额度，或稍后再试。");
      }
      
      throw new Error(errorMessage);
    }

    const { audio } = await res.json();
    const binaryString = atob(audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let j = 0; j < binaryString.length; j++) {
      bytes[j] = binaryString.charCodeAt(j);
    }
    return bytes.buffer;
  }
  throw new Error("Failed to fetch TTS after retries");
};

// Simple WAV header creation if it's raw PCM
export function encodeWAV(samples: Float32Array, sampleRate: number = 24000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return buffer;
}


// A helper to decode audio buffer. Uses AudioContext.
let sharedCtx: AudioContext | null = null;
export const getAudioContext = () => {
  if (!sharedCtx) sharedCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return sharedCtx;
};

export const decodeAudio = async (buffer: ArrayBuffer): Promise<AudioBuffer> => {
  const ctx = getAudioContext();
  try {
    // Try to decode normally (if it's already WAV)
    const clone1 = buffer.slice(0);
    return await ctx.decodeAudioData(clone1);
  } catch (e) {
    // If it fails, assume it's 24kHz raw PCM 16-bit
    // 隐藏这里的警告，因为回落到 PCM 解析是正常行为
    const view = new DataView(buffer);
    const floats = new Float32Array(buffer.byteLength / 2);
    for (let i = 0; i < floats.length; i++) {
      const int16 = view.getInt16(i * 2, true);
      floats[i] = int16 / (int16 < 0 ? 32768 : 32767);
    }
    const wavBuffer = encodeWAV(floats, 24000);
    return await ctx.decodeAudioData(wavBuffer);
  }
};
