export interface GatewayMessage {
  id: string;
  platform: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformAdapter {
  platformId: string;
  name: string;
  isConfigured(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(channelId: string, text: string, options?: Record<string, unknown>): Promise<void>;
  onMessage(handler: (msg: GatewayMessage) => Promise<void>): void;
}
