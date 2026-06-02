import { GoogleGenAI } from "@google/genai";

export const maxDuration = 60; // Increase Vercel serverless timeout limit

export default async function handler(req: any, res: any) {
  // Add CORS headers just in case Vercel is rejecting from frontend
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    let body = req.body;
    
    // In rare cases Vercel might pass a raw buffer or string
    if (Buffer.isBuffer(body)) {
      body = body.toString('utf8');
    }
    if (typeof body === 'string') {
       try { body = JSON.parse(body); } catch(e) {}
    }

    if (!body || typeof body !== 'object') {
       return res.status(400).json({ error: "Invalid request body format. Expected JSON." });
    }

    const { text, voiceName, customApiKey, baseUrl, openRouterKey } = body;
    
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
         const errText = await response.text();
         let errObj;
         try { errObj = JSON.parse(errText); } catch(e) {}
         throw new Error(`OpenRouter Error: ${errObj?.error?.message || errText || response.statusText}`);
      }
      
      const data = await response.json();
      const base64Audio = data.choices?.[0]?.message?.audio?.data;
      if (!base64Audio) {
         throw new Error("OpenRouter generated no audio content. Response: " + JSON.stringify(data));
      }
      return res.json({ audio: base64Audio });
    }

    const apiKey = customApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "No API Key provided. Set GEMINI_API_KEY in Vercel environment variables or enter one in the UI settings." });
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
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: `Failed to generate audio from Gemini. Raw response object empty or missing inlineData.` });
    }

    return res.json({ audio: base64Audio });
  } catch (error: any) {
    console.error("TTS Error:", error);
    
    let status = 500;
    let message = error.message || "Failed to generate TTS";
    
    if (typeof error.status === 'number') {
      status = error.status;
    } else if (message.includes("429") || message.includes("Quota") || message.includes("RESOURCE_EXHAUSTED") || error.status === "RESOURCE_EXHAUSTED") {
      status = 429;
    }

    return res.status(status).json({ 
       error: message,
       stack: error.stack,
       details: error.toString()
    });
  }
}
