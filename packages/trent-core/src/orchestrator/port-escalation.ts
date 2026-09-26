/**
 * [L1] The planner/critic port's gateway with `models.escalate` (`model-gateway/escalation.ts`).
 *
 * Both the planner and the critic reach the gateway through the same `createCompletion` port with the
 * gateway role `planner`, so the role an escalation is asked for comes from the run's phase: the
 * planner until `plan_end`, the critic after (`PortTally`, which the wrapper advances on `plan_end`).
 * The gateway handed in is the metered one, so a hosted answer is on the ledger under the same role.
 * A held call is answered by the local model; the row waits in `trent approvals list`.
 */
import { withRoleEscalation } from "../model-gateway/escalation.js";
import type { ModelGateway } from "../model-gateway/types.js";
import type { PortTally } from "./provider-ports.js";

export function portGatewayWithEscalation(gateway: ModelGateway, ports: PortTally): ModelGateway {
  return withRoleEscalation(gateway, () => (ports.executing ? "critic" : "planner"));
}
