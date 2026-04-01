import { useEffect, useRef, useState } from 'react';

export interface WSMessage {
  type: string;
  payload: any;
}

export function useWebSocket(url: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [messages, setMessages] = useState<WSMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout>>();
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;

    function connect() {
      // Don't connect if the effect has been cleaned up
      if (!activeRef.current) return;
      // Close any existing connection
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }

      try {
        const ws = new WebSocket(url);

        ws.onopen = () => {
          if (!activeRef.current) { ws.close(); return; }
          console.log('WebSocket connected');
          setIsConnected(true);
        };

        ws.onmessage = (event) => {
          if (!activeRef.current) return;
          try {
            const data: WSMessage = JSON.parse(event.data);
            setLastMessage(data);
            setMessages((prev) => [data, ...prev].slice(0, 100));
          } catch (e) {
            console.error('Failed to parse WS message:', e);
          }
        };

        ws.onclose = () => {
          if (!activeRef.current) return;
          console.log('WebSocket disconnected, reconnecting in 3s...');
          setIsConnected(false);
          reconnectTimeout.current = setTimeout(connect, 3000);
        };

        ws.onerror = (err) => {
          console.error('WebSocket error:', err);
          ws.close();
        };

        wsRef.current = ws;
      } catch (e) {
        console.error('WebSocket connection failed:', e);
        if (activeRef.current) {
          reconnectTimeout.current = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    return () => {
      activeRef.current = false;
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [url]);

  return { isConnected, lastMessage, messages };
}
