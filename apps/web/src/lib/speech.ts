// ---------------------------------------------------------------------------
// Speech — voice input (SpeechRecognition) + voice playback (speechSynthesis)
// Zero-dependency wrappers over the Web Speech API with feature detection.
// ---------------------------------------------------------------------------

export type SpeechLang = "zh-CN" | "en-US";

interface RecognitionResultLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>> & { length: number };
  resultIndex: number;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: RecognitionResultLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isVoiceInputSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isVoiceOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

interface ActiveListening {
  stop: () => void;
}

/** 开始听写;interim 结果实时回传,final 由调用方决定何时 stop。 */
export function startListening(options: {
  lang: SpeechLang;
  onInterim: (text: string) => void;
  onFinalChunk: (text: string) => void;
  onEnd?: () => void;
}): ActiveListening | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = options.lang === "zh-CN" ? "zh-CN" : "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const resultItem = event.results[i] as unknown as {
        isFinal?: boolean;
        0: { transcript: string };
      };
      const transcript = resultItem[0]?.transcript ?? "";
      const finalFlag = resultItem.isFinal ?? false;

      if (finalFlag) {
        if (transcript.trim()) options.onFinalChunk(transcript.trim());
      } else {
        interim += transcript;
      }
    }
    if (interim) options.onInterim(interim);
  };

  recognition.onend = () => options.onEnd?.();
  recognition.onerror = () => options.onEnd?.();

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // already stopped
      }
    }
  };
}

let voiceEnabled = false;

export function setVoiceOutputEnabled(enabled: boolean): void {
  voiceEnabled = enabled;
  if (!enabled && isVoiceOutputSupported()) {
    window.speechSynthesis.cancel();
  }
  try {
    window.sessionStorage.setItem("neuroclaw.voice", enabled ? "1" : "0");
  } catch {
    // ignore
  }
}

export function isVoiceOutputEnabled(): boolean {
  try {
    return window.sessionStorage.getItem("neuroclaw.voice") === "1";
  } catch {
    return false;
  }
}

/** 播报助手文本(仅在用户开启语音模式时发声)。 */
export function speak(text: string, lang: SpeechLang): void {
  if (!voiceEnabled || !isVoiceOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 220));
    utterance.lang = lang === "zh-CN" ? "zh-CN" : "en-US";
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  } catch {
    // TTS unavailable — silent
  }
}
