import { useEffect, useRef, useState } from "react";

export type StreamHealth = "off" | "live" | "fallback";

/**
 * 订阅 /api/runs/:id/events SSE(Round Q 修复后默认开启):
 * 服务端差量推送 run 变更帧;EventSource 断线自动重连;连续失败回退轮询。
 * 可用 VITE_RUN_SSE=0 显式关闭。
 */
const SSE_ENABLED =
  String(import.meta.env?.VITE_RUN_SSE ?? "") !== "0";

export function useRunEventStream(props: {
  runId: string;
  enabled: boolean;
  onUpdate: (run: unknown) => void;
}): StreamHealth {
  const { runId, enabled, onUpdate } = props;
  const [health, setHealth] = useState<StreamHealth>("off");
  const failuresRef = useRef(0);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!SSE_ENABLED || !enabled || typeof window === "undefined" || !window.EventSource) {
      setHealth("off");
      return;
    }

    setHealth("live");
    failuresRef.current = 0;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);

    source.addEventListener("run", (event) => {
      try {
        onUpdateRef.current(JSON.parse((event as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });

    source.addEventListener("bye", () => {
      source.close();
    });

    source.onerror = () => {
      failuresRef.current += 1;
      // EventSource retries on its own; after repeated failures give up and
      // let the caller fall back to interval polling.
      if (failuresRef.current >= 3) {
        source.close();
        setHealth("fallback");
      }
    };

    return () => {
      source.close();
    };
  }, [runId, enabled]);

  return health;
}
