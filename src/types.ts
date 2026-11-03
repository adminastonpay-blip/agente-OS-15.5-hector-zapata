export interface Env {
  AI: Ai;
  SESSION: DurableObjectNamespace;
  AI_GATEWAY_ID: string;
  CHAT_MODEL: string;
  EMBED_MODEL: string;
  DEPLOY_PROFILE?: string;
  API_KEY?: string;
}
