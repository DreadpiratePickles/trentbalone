/**
 * The Agent Card this server publishes at the well-known URI (spec §5.5).
 *
 * The card is the only thing a stranger reads before talking to Trent, so every field in it has to
 * be true of the running process. The nine skills are therefore DERIVED from the seat roster
 * (`../fleet/AgentInstaller.ts`, itself read from the wrapped application) rather than restated
 * here: a seat added or renamed in the app changes the card without anyone remembering to.
 *
 * `security` is present only when the server actually enforces a token. A card that advertises
 * authentication a server does not check is worse than a card that admits it has none.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */

import { CORE_ROLES } from "../fleet/AgentInstaller.js";
import {
  A2A_PROTOCOL_VERSION,
  A2A_TEXT_MEDIA_TYPE,
  A2A_TRANSPORT_JSONRPC,
  type A2AAgentCard,
  type A2AAgentSkill,
} from "./spec.js";

/** The security scheme name the card declares and the server checks. */
export const A2A_SECURITY_SCHEME = "bearerAuth";

/** The agent name and description on the card. Identity, not a generated answer. */
const AGENT_NAME = "Trent Fleet";
const AGENT_DESCRIPTION =
  "An autonomous cofounder fleet. One message is one orchestration run across the seats below, and the run's own output comes back as the task artifact.";

export interface AgentCardOptions {
  /** The JSON-RPC endpoint this card advertises, which is the server root. */
  readonly url: string;
  /** The release of Trent serving the card. */
  readonly version: string;
  /** True when the server checks a bearer token, which is the only time `security` is truthful. */
  readonly authenticated?: boolean;
  readonly documentationUrl?: string;
}

/** One skill per seat, in roster order. The seat's own name and description, never a rewrite. */
export function agentCardSkills(): A2AAgentSkill[] {
  return Object.entries(CORE_ROLES).map(([id, seat]) => ({
    id,
    name: seat.name,
    description: seat.description,
    tags: [seat.category, seat.modelPolicy],
    inputModes: [A2A_TEXT_MEDIA_TYPE],
    outputModes: [A2A_TEXT_MEDIA_TYPE],
  }));
}

/** The card for a running server. Everything in it is read from that server, not from a literal. */
export function buildAgentCard(options: AgentCardOptions): A2AAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    url: options.url,
    preferredTransport: A2A_TRANSPORT_JSONRPC,
    version: options.version,
    capabilities: {
      // Real: `message/stream` folds the orchestrator's own event stream into SSE frames.
      streaming: true,
      // Neither is implemented; saying so is what stops a client waiting for a webhook forever.
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: [A2A_TEXT_MEDIA_TYPE],
    defaultOutputModes: [A2A_TEXT_MEDIA_TYPE],
    skills: agentCardSkills(),
    securitySchemes: {
      [A2A_SECURITY_SCHEME]: {
        type: "http",
        scheme: "bearer",
        description: "The token from the profile secrets file, presented as an Authorization header.",
      },
    },
    // Omitted when no token is configured: an absent `security` means the endpoint takes anyone,
    // which is exactly what a loopback server with no token does.
    ...(options.authenticated === true ? { security: [{ [A2A_SECURITY_SCHEME]: [] }] } : {}),
    ...(options.documentationUrl === undefined ? {} : { documentationUrl: options.documentationUrl }),
    supportsAuthenticatedExtendedCard: false,
  };
}
