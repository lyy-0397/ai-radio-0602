import { GoogleGenAI, Modality } from "@google/genai";

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { text, voiceName, customApiKey, baseUrl, openRouterKey } = req.body;
    if (!text || !voiceName) {
      return res.status(400).json({ error: "Missing text or voiceName" });
    }

    if (openRouterKey) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
              "Authorization": `Bearer ${openRouterKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://aistudio.google.com",
              "X-Title": "Audio Cast Studio"
          },
          body: JSON.stringify({
              model: "google/gemini-3.1-flash-tts-preview",
              messages: [{ role: "user", content: text }],
              modalities: ["audio"],
              audio: { voice: voiceName, format: "wav" }
          })
      });
      
      if (!response.ok) {
         const err = await response.json().catch(()=>({}));
         throw new Error(`OpenRouter Error: ${err.error?.message || response.statusText}`);
      }
      
      const data = await response.json();
      const base64Audio = data.choices?.[0]?.message?.audio?.data;
      if (!base64Audio) {
         throw new Error("OpenRouter generated no audio content. Please make sure the model supports TTS or use Gemini API key instead.");
      }
      return res.json({ audio: base64Audio });
    }

    const apiKey = customApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "No API Key provided" });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        baseUrl: baseUrl || undefined,
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: "Failed to generate audio" });
    }

    res.json({ audio: base64Audio });
  } catch (error: any) {
    console.error("TTS Error:", error);
    
    let status = 500;
    let message = error.message || "Failed to generate TTS";
    
    if (typeof error.status === 'number') {
      status = error.status;
    } else if (message.includes("429") || message.includes("Quota") || message.includes("RESOURCE_EXHAUSTED") || error.status === "RESOURCE_EXHAUSTED") {
      status = 429;
    }

    res.status(status).json({ error: message });
  }
}
