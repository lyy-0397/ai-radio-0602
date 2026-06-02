import { Settings, Play, Download, Wand2, Pause, Volume2, Save, Trash2, Mic2 } from "lucide-react";
import React, { useState, useEffect, useRef } from "react";
import {
  parseScript,
  VoiceName,
  fetchTTS,
  decodeAudio,
  getAudioContext,
  encodeWAV,
} from "./audioHelper";

const DEFAULT_SCRIPT = `A：诶你们听说了没？视传的创新设计课程那边搞了个不一样的。
B：你说那个“多人协作代码”吗？我听说了。话说我还以为他们只做平面啊海报啊什么的呢
A：“多人协作代码”，听起来是好几个人一起整的，感觉好专业啊。欸？那他们最后怎么交作业？交个网页？交个APP？然后ppt汇报吗？
C：听说他们不搞正经ppt汇报，要整成一场dj show！
B：啊？写代码写成了打碟？咱这是美院没错吧
A：广美变星海是吗，笑死我了！好像不止有代码打碟啥的吧，还有个3d虚拟展馆来展示他们的个人作业来着，可以看看
C：对，他们把整个课程成果做成了视听现场，而且据说屏幕跟着节拍走。走去看看？
A：行，去看看
BC合：欸走那么快干嘛，等等我——`;

const VOICES: VoiceName[] = ["Aoede", "Kore", "Puck", "Charon", "Fenrir"];

const VOICE_LABELS: Record<VoiceName, string> = {
  Aoede: "Aoede (热情开朗女性)",
  Kore: "Kore (沉稳优美女性)",
  Puck: "Puck (朝气蓬勃男性)",
  Charon: "Charon (磁性低沉男性)",
  Fenrir: "Fenrir (成熟稳重男性)"
};

export default function App() {
  const [script, setScript] = useState(() => {
    return localStorage.getItem("draftScript") || DEFAULT_SCRIPT;
  });
  const [apiKey, setApiKey] = useState(() => {
    return localStorage.getItem("customApiKey") || "";
  });
  const [baseUrl, setBaseUrl] = useState(() => {
    return localStorage.getItem("customBaseUrl") || "";
  });
  const [openRouterKey, setOpenRouterKey] = useState(() => {
    return localStorage.getItem("openRouterKey") || "";
  });
  const [showSettings, setShowSettings] = useState(false);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [speakerVoices, setSpeakerVoices] = useState<Record<string, VoiceName>>({});

  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generatedBlobUrl, setGeneratedBlobUrl] = useState<string | null>(null);

  // Parse script whenever it changes
  useEffect(() => {
    localStorage.setItem("draftScript", script);
    const { speakers: parsedSpeakers } = parseScript(script);
    setSpeakers(parsedSpeakers);
    
    // Assign default voices if none provided
    setSpeakerVoices((prev) => {
      const next = { ...prev };
      parsedSpeakers.forEach((s, i) => {
        if (!next[s]) {
          next[s] = VOICES[i % VOICES.length];
        }
      });
      return next;
    });
  }, [script]);

  const saveSettings = (k: string, url: string, orKey: string) => {
    setApiKey(k);
    setBaseUrl(url);
    setOpenRouterKey(orKey);
    localStorage.setItem("customApiKey", k);
    localStorage.setItem("customBaseUrl", url);
    localStorage.setItem("openRouterKey", orKey);
    setShowSettings(false);
  };

  const handlePreviewVoice = async (voice: VoiceName) => {
    try {
      const text = "你好！这是一段试听语音。";
      const buffer = await fetchTTS(text, voice, apiKey, baseUrl, openRouterKey);
      const audioBuf = await decodeAudio(buffer);
      const ctx = getAudioContext();
      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);
      source.start(0);
    } catch (e: any) {
      alert(`试听失败: ${e.message}\n可能遇到限流，请稍后再试或在设置中绑定个人 API Key。`);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setProgress(0);
    setGeneratedBlobUrl(null);

    try {
      const { characterLines } = parseScript(script);
      const partsToMix: { buffer: AudioBuffer; startTime: number }[] = [];
      let currentStartTime = 0;

      for (let i = 0; i < characterLines.length; i++) {
        const line = characterLines[i];
        if (line.speakers.length === 0 || !line.text) {
          currentStartTime += 0.5;
          setProgress(((i + 1) / characterLines.length) * 100);
          continue;
        }

        // 依次获取同一行中的发音人（如“BC合”的情况），避免并发请求导致 429 限流
        const lineAudioBuffers = [];
        for (const speaker of line.speakers) {
          const voice = speakerVoices[speaker];
          if (!voice) continue;
          const rawBuffer = await fetchTTS(line.text, voice, apiKey, baseUrl, openRouterKey);
          const decoded = await decodeAudio(rawBuffer);
          lineAudioBuffers.push(decoded);
          
          if (line.speakers.length > 1) {
            // 多个发音人同时在线时，请求间隙等待避免限流
            await new Promise(r => setTimeout(r, 6500));
          }
        }

        let maxLineDuration = 0;
        lineAudioBuffers.forEach((buf) => {
          if (buf) {
            partsToMix.push({ buffer: buf, startTime: currentStartTime });
            if (buf.duration > maxLineDuration) {
              maxLineDuration = buf.duration;
            }
          }
        });

        // Add duration + pause
        currentStartTime += maxLineDuration + 0.3; // 0.3s pause between lines
        setProgress(((i + 1) / characterLines.length) * 100);

        // 避免极速并发引发 429 限流
        if (i < characterLines.length - 1) {
          await new Promise(r => setTimeout(r, 6500));
        }
      }

      if (partsToMix.length === 0) {
        throw new Error("No dialogue generated. Check your script format.");
      }

      const maxTime = partsToMix.reduce((max, obj) => Math.max(max, obj.startTime + obj.buffer.duration), 0);
      const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, Math.ceil(maxTime * 24000), 24000);
      
      partsToMix.forEach(({ buffer, startTime }) => {
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(offlineCtx.destination);
        source.start(startTime);
      });

      const renderedBuffer = await offlineCtx.startRendering();
      const channelData = renderedBuffer.getChannelData(0);
      const wavBuffer = encodeWAV(channelData, renderedBuffer.sampleRate);
      
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setGeneratedBlobUrl(url);

    } catch (e: any) {
      alert("生成失败: " + e.message + "\n\n提示：连续生成较长文本引发了共享配额受限。您可以配置使用个人的专属 API Key 获得更高的调用额度。");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden select-none">
      {/* Header Navigation */}
      <header className="h-16 shrink-0 border-b border-slate-200 backdrop-blur-md flex items-center justify-between px-4 md:px-8 bg-white/70">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center shadow-[0_0_15px_rgba(99,102,241,0.5)]">
             <Mic2 className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">Audio Cast Studio</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200">
             <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
             <span className="text-xs text-emerald-600 font-medium">系统就绪</span>
          </div>
          <button 
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors"
          >
            <Settings className="w-5 h-5 text-slate-600" />
          </button>
        </div>
      </header>

      {/* Main Content Layout */}
      <main className="flex-1 flex flex-col lg:flex-row gap-6 p-4 md:p-6 overflow-hidden">
        {/* Left: Script Editor */}
        <div className="flex-1 lg:w-1/2 flex flex-col gap-4 min-h-0">
          <div className="flex items-center justify-between shrink-0">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-widest">台词脚本</h2>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200 hidden md:block">已启用智能分角</span>
              <button 
                 onClick={() => setScript("")} 
                 className="text-[10px] text-slate-500 hover:text-slate-900 bg-white hover:bg-slate-100 px-2 py-1 rounded border border-slate-200 transition-colors flex items-center gap-1"
              >
                 <Trash2 className="w-3 h-3" /> 清空文本
              </button>
            </div>
          </div>
          <div className="flex-1 rounded-2xl border border-slate-200 bg-white shadow-sm p-4 md:p-6 min-h-0">
            <textarea
              className="w-full h-full bg-transparent border-none focus:ring-0 text-slate-800 leading-relaxed resize-none scrollbar-hide text-sm md:text-base outline-none"
              spellCheck="false"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="例如：&#10;A: 大家好！&#10;B: 你好啊！"
            />
          </div>
        </div>

        {/* Right: Role Intelligence & Configuration */}
        <div className="flex-1 lg:w-1/2 flex flex-col gap-4 min-h-0">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-widest shrink-0">角色音色配置</h2>
          
          <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
            {speakers.length === 0 ? (
               <div className="text-slate-400 text-sm italic py-8 text-center border border-dashed border-slate-300 rounded-xl">
                 未检测到角色。请按照 "角色名: 台词" 格式编写。
               </div>
            ) : (
               speakers.map((speaker, index) => {
                 const colors = [
                   "from-indigo-500 to-purple-500",
                   "from-emerald-500 to-teal-500",
                   "from-amber-500 to-orange-500",
                   "from-rose-500 to-pink-500",
                   "from-sky-500 to-blue-500"
                 ];
                 const bgGradient = colors[index % colors.length];

                 return (
                   <div key={speaker} className="rounded-xl border border-slate-200 bg-white p-4 hover:border-indigo-400 transition-all group shrink-0 shadow-sm">
                     <div className="flex items-center justify-between mb-3">
                       <div className="flex items-center gap-3">
                         <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${bgGradient} flex items-center justify-center text-lg font-bold text-white shadow-sm`}>
                            {speaker.substring(0, 2)}
                         </div>
                         <div>
                           <p className="text-sm font-bold text-slate-800">角色 {speaker}</p>
                           <p className="text-[11px] text-slate-500">声音设置</p>
                         </div>
                       </div>
                       <button 
                         onClick={() => handlePreviewVoice(speakerVoices[speaker])}
                         className="px-3 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs hover:bg-slate-100 transition-colors flex items-center gap-1 text-slate-700 font-medium"
                       >
                         <Play className="w-3 h-3 text-indigo-500" /> 试听
                       </button>
                     </div>
                     <select
                       value={speakerVoices[speaker] || VOICES[0]}
                       onChange={(e) => setSpeakerVoices({...speakerVoices, [speaker]: e.target.value as VoiceName})}
                       className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
                     >
                       {VOICES.map((v) => (
                         <option key={v} value={v}>{VOICE_LABELS[v]}</option>
                       ))}
                     </select>
                   </div>
                 );
               })
            )}
          </div>
        </div>
      </main>

      {/* Bottom Control Bar */}
      <footer className="h-auto md:h-24 py-4 md:py-0 border-t border-slate-200 bg-white/80 backdrop-blur-2xl flex flex-col md:flex-row items-center px-4 md:px-10 gap-4 md:gap-8 shrink-0">
        <div className="flex-1 flex w-full flex-col gap-2">
          <div className="flex justify-between text-[11px] text-slate-500 font-bold">
            <span>{isGenerating ? "合成中..." : "准备就绪"}</span>
            <span>{isGenerating ? `${Math.round(progress)}%` : "100%"}</span>
          </div>
          <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden relative">
            <div 
              className="absolute left-0 top-0 h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300 ease-out"
              style={{ width: `${isGenerating ? progress : (generatedBlobUrl ? 100 : 0)}%` }}
            ></div>
            {isGenerating && (
              <div className="absolute left-0 top-0 h-full w-[1px] bg-white shadow-[0_0_10px_white] animate-[ping_1.5s_infinite]" style={{ left: `${progress}%` }}></div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 w-full md:w-auto justify-end">
          {generatedBlobUrl && !isGenerating && (
             <audio className="h-8 max-w-[180px] outline-none rounded-lg" controls src={generatedBlobUrl}></audio>
          )}

          {generatedBlobUrl && !isGenerating ? (
            <a 
              href={generatedBlobUrl}
              download="generated-dialogue.wav"
              className="h-12 px-6 rounded-full bg-indigo-600 text-white font-bold hover:scale-105 transition-transform shadow-[0_0_20px_rgba(79,70,229,0.2)] flex items-center gap-2 whitespace-nowrap"
            >
              <Download className="w-5 h-5" /> 下载音频
            </a>
          ) : (
            <button 
              onClick={handleGenerate}
              disabled={isGenerating || speakers.length === 0}
              className={`h-12 px-6 md:px-8 rounded-full font-bold transition-transform flex items-center gap-2 whitespace-nowrap ${
                isGenerating || speakers.length === 0
                 ? "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
                 : "bg-indigo-600 text-white hover:scale-105 shadow-[0_0_20px_rgba(79,70,229,0.3)]"
              }`}
            >
              {isGenerating ? (
                 <>
                   <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                   生成音频...
                 </>
              ) : (
                 <>
                   <Wand2 className="w-5 h-5" /> 生成音频
                 </>
              )}
            </button>
          )}
        </div>
      </footer>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center px-4 animate-in fade-in">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-bold text-slate-800 tracking-widest">设置</span>
              <div className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_8px_#6366f1]"></div>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">GEMINI API KEY (可选)</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 transition-colors"
                />
                
                <label className="block text-xs font-bold text-slate-600 mb-1 mt-4">API Base URL (可选, 供代理使用)</label>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-proxy-domain.com"
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 transition-colors"
                />

                <label className="block text-xs font-bold text-slate-600 mb-1 mt-4">OpenRouter API Key (可选)</label>
                <input
                  type="password"
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                  placeholder="sk-or-v1-..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 transition-colors"
                />
                <p className="text-[10px] text-rose-500 mt-2 leading-relaxed">注意：OpenRouter 官方接口暂不支持音频内容生成（TTS），如果使用上述请求会报错。为了能正常生成音频，请清空本项并使用下方的原生 Gemini Key。</p>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                >
                  取消
                </button>
                <button 
                  onClick={() => saveSettings(apiKey, baseUrl, openRouterKey)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-transform hover:scale-105 shadow-[0_0_15px_rgba(99,102,241,0.4)]"
                >
                  保存设置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
