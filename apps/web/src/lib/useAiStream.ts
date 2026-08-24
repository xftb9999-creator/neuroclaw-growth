import { useCallback, useRef, useState } from "react";

export interface StreamState {
  status: "idle" | "connecting" | "streaming" | "done" | "error";
  partial: unknown;
  result: unknown;
  error: string | null;
  isMock: boolean;
}

export interface UseAiStreamOptions {
  onPartial?: (data: unknown) => void;
  onComplete?: (data: unknown) => void;
  onError?: (message: string) => void;
}

export function useAiStream(options: UseAiStreamOptions = {}) {
  const [state, setState] = useState<StreamState>({
    status: "idle",
    partial: null,
    result: null,
    error: null,
    isMock: false
  });

  const abortRef = useRef<AbortController | null>(null);

  const stream = useCallback(
    async (
      templateType: "content_acquisition" | "private_conversion" | "weekly_review",
      input: Record<string, unknown>
    ): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        status: "connecting",
        partial: null,
        result: null,
        error: null,
        isMock: false
      });

      try {
        const response = await fetch("/api/ai/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.NEUROCLAW_API_KEY
              ? { Authorization: `Bearer ${process.env.NEUROCLAW_API_KEY}` }
              : {})
          },
          body: JSON.stringify({ templateType, input }),
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "Request failed");
          throw new Error(`${response.status}: ${text}`);
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        setState((s) => ({ ...s, status: "streaming" }));

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              const dataStr = line.slice(5).trim();
              if (!dataStr) continue;

              try {
                const data = JSON.parse(dataStr);

                if (currentEvent === "status") {
                  setState((s) => ({ ...s, isMock: data.aiEnabled === false }));
                } else if (currentEvent === "partial") {
                  setState((s) => ({
                    ...s,
                    partial: data,
                    isMock: data._mock === true
                  }));
                  options.onPartial?.(data);
                } else if (currentEvent === "complete") {
                  setState((s) => ({
                    ...s,
                    status: "done",
                    result: data
                  }));
                  options.onComplete?.(data);
                } else if (currentEvent === "error") {
                  const msg = data.message ?? "Stream error";
                  setState((s) => ({ ...s, status: "error", error: msg }));
                  options.onError?.(msg);
                }
              } catch {
                // ignore parse errors for incomplete chunks
              }
              currentEvent = "";
            }
          }
        }

        setState((s) => (s.status === "done" ? s : { ...s, status: "done" }));
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        const msg = error instanceof Error ? error.message : "Stream failed";
        setState((s) => ({ ...s, status: "error", error: msg }));
        options.onError?.(msg);
      }
    },
    [options]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, status: "idle" }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({
      status: "idle",
      partial: null,
      result: null,
      error: null,
      isMock: false
    });
  }, []);

  return { state, stream, abort, reset };
}
