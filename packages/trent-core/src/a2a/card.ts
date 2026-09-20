/**
 * The Agent Card this server publishes at the well-known URI (spec §5.5).
 *
 * The card is the only thing a stranger reads before talking to Trent, so every field in it has to
 * be true of the running process. The nine skills are therefore DERIVED from the seat roster
 * (`../fleet/AgentInstaller.ts`, itself read from the wrapped application) rather than restated
 * here: a seat added or renamed in the app changes the card without anyone remembering to.
 *
 * `security` is present only when the server actually enforces a token. A card that advertises
 * authentication a server does not check is worse than a card that admits it has none. By the
 * same rule `supportedInterfaces` names A2A v1.0 at the server root only because `rpc.ts` and
 * `A2AServer.ts` answer the v1.0 method names there (`./v1.ts`); the 0.3.0 fields stay because
 * the 0.3.0 methods are answered at the same root. Hermes v0.21.3 reads the interface first and
 * labels the card `JSONRPC v1.0`; a 0.3 client reads `url` and `protocolVersion` as before.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */

import { CORE_ROLES } from "../fleet/AgentInstaller.js";
import { seatCapability } from "../fleet/seat-capabilities.js";
import {
  A2A_PROTOCOL_VERSION,
  A2A_TEXT_MEDIA_TYPE,
  A2A_TRANSPORT_JSONRPC,
  type A2AAgentCard,
  type A2AAgentSkill,
} from "./spec.js";
import { A2A_V1_PROTOCOL_VERSION } from "./v1.js";

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

/**
 * One skill per seat, in roster order. The seat's own name and description, never a rewrite.
 * [W5] The tags are the seat's Trent toolsets, read from its capability record, so a tag is a
 * name a peer's operator can ask for (`terminal`, `web`, ...), not a category label or a model
 * policy. Hermes's `a2a_orchestrate(capability, ...)` matches that word against the
 * `capabilities` list ITS operator writes under `a2a_agents.<peer>` in config.yaml, not against
 * this card (Hermes v0.21.3 `plugins/platforms/a2a/tools.py`; proof in
 * docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md); the tags are what that operator
 * copies there. A seat the manifests do not define is a configuration error here, as everywhere.
 */
export function agentCardSkills(): A2AAgentSkill[] {
  return Object.entries(CORE_ROLES).map(([id, seat]) => ({
    id,
    name: seat.name,
    description: seat.description,
    tags: [...seatCapability(id).toolsets],
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
    // v1.0 discovery: the same root answers `SendMessage`, `SendStreamingMessage`, `GetTask` and
    // `CancelTask` in v1.0 shapes, so a v1.0 client is told so (`./v1.ts`).
    supportedInterfaces: [{ url: options.url, protocolBinding: A2A_TRANSPORT_JSONRPC, protocolVersion: A2A_V1_PROTOCOL_VERSION }],
    version: options.version,
    capabilities: {
      // Real: `message/stream` folds the orchestrator's own event stream into SSE frames.
      streaming: true,
      // Neither is implemented; saying so is what stops a client waiting for a webhook forever.
      pushNotifications: false,
      stateTransitionHistory: false,
      // v1.0's spelling of `supportsAuthenticatedExtendedCard` below: one card, at the well-known URI.
      extendedAgentCard: false,
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
